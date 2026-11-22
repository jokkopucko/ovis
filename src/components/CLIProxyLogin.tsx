import { useEffect, useRef, useState } from "react";
import { Network } from "lucide-react";
import type { CLIProxyLogin, CLIProxyLoginStatus, CLIProxyProvider } from "../../shared/protocol.ts";
import { cliProxyRequest } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { ExternalLink, reserveTab } from "../lib/externalLink.ts";

type Pending = CLIProxyLogin & { readonly provider: CLIProxyProvider };
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function CLIProxyAccountLogin({ provider, active, onStarted, onAccountsChanged }: {
  readonly provider: CLIProxyProvider;
  readonly active: boolean;
  readonly onStarted: () => void;
  readonly onAccountsChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const onChanged = useRef(onAccountsChanged);
  onChanged.current = onAccountsChanged;
  useEffect(() => {
    if (active || !pending) return;
    setPending(null); setBusy(false); setError(null);
    void cliProxyRequest(`/login?state=${encodeURIComponent(pending.state)}`, { method: "DELETE" }).catch((cause: unknown) => {
      if (!lifetime.current?.signal.aborted) setError(cause instanceof Error ? cause.message : t("Hub request failed"));
    });
  }, [active, pending, t]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      const current = pendingRef.current;
      if (current) void cliProxyRequest(`/login?state=${encodeURIComponent(current.state)}`, { method: "DELETE" }).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => {
      controller.abort();
      setPending(null);
      setError(t("Sign-in timed out. Try again."));
      void cliProxyRequest(`/login?state=${encodeURIComponent(pending.state)}`, { method: "DELETE" }).catch(() => undefined);
    }, 5 * 60_000);
    const poll = async () => {
      try {
        const status = await cliProxyRequest<CLIProxyLoginStatus>(`/login?state=${encodeURIComponent(pending.state)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (controller.signal.aborted) return;
        switch (status.status) {
          case "wait": timer = setTimeout(() => void poll(), 1500); break;
          case "ok": pendingRef.current = null; setPending(null); onChanged.current(); break;
          case "error": setPending(null); setError(t("Hub request failed")); break;
          default: { const unexpected: never = status.status; throw new Error(String(unexpected)); }
        }
      } catch (cause) {
        if (!controller.signal.aborted) { setPending(null); setError(cause instanceof Error ? cause.message : t("Hub request failed")); }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
  }, [pending, t]);

  const start = (provider: CLIProxyProvider) => {
    const popup = reserveTab();
    if (!popup) { setError(t("Allow popups to sign in")); return; }
    onStarted();
    setBusy(true); setError(null);
    void cliProxyRequest<CLIProxyLogin>("/login", json("POST", { provider })).then((login) => {
      if (lifetime.current?.signal.aborted) {
        popup.close();
        void cliProxyRequest(`/login?state=${encodeURIComponent(login.state)}`, { method: "DELETE" }).catch(() => undefined);
        return;
      }
      popup.location.href = login.url;
      pendingRef.current = { ...login, provider };
      setPending({ ...login, provider });
    }).catch((cause: unknown) => {
      popup.close();
      if (!lifetime.current?.signal.aborted) setError(cause instanceof Error ? cause.message : t("Hub request failed"));
    }).finally(() => { if (!lifetime.current?.signal.aborted) setBusy(false); });
  };

  const cancel = async () => {
    const current = pending;
    setPending(null);
    if (!current) return;
    try { await cliProxyRequest(`/login?state=${encodeURIComponent(current.state)}`, { method: "DELETE" }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("Hub request failed")); }
  };

  return (
      <div className="usage-hub-login">
        {error && <p className="settings-hint account-error" role="alert">{error}</p>}
        {pending ? <>
          <p className="settings-label" role="status">{t("Waiting for sign-in…")}</p>
          <ExternalLink kind="sign-in" href={pending.url}>{t("Open sign-in again")}</ExternalLink>
          <button className="btn btn-ghost" type="button" onClick={() => void cancel()}>{t("Cancel")}</button>
          <form onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const redirect = new FormData(form).get("redirect_url");
            setError(null); setBusy(true);
            void cliProxyRequest("/callback", json("POST", { provider: pending.provider, state: pending.state, redirect_url: redirect }))
              .then(() => form.reset())
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("Hub request failed")))
              .finally(() => setBusy(false));
          }}>
            <label className="settings-label" htmlFor={`cliproxy-redirect-${provider}`}>{t("On another device? Paste the address you landed on.")}</label>
            <input className="input" id={`cliproxy-redirect-${provider}`} name="redirect_url" type="url" required autoComplete="off" />
            <button className="btn" type="submit" disabled={busy}>{t("Submit")}</button>
          </form>
        </> : <button className="account-choice" type="button" disabled={busy} onClick={() => start(provider)}><Network size={24} aria-hidden="true" /><span><strong>{t("Through the hub")}</strong><span className="settings-hint">{t("Sign in with your hub")}</span></span></button>}
      </div>
  );
}
