import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Network, SquareTerminal, X } from "lucide-react";
import type { CLIProxyStatus, UsageProviderId } from "../../shared/protocol.ts";
import type { UsageLoginProvider } from "../../shared/usage-login.ts";
import { fetchUsageLoginProviders } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { PROVIDER_MARK, PROVIDER_NAME } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";
import { CLIProxyAccountLogin } from "./CLIProxyLogin.tsx";
import { UsageHubConnect } from "./UsageHubConnect.tsx";
import { UsageLocalLogin } from "./UsageLocalLogin.tsx";
import "./UsageAccountDialog.css";

type Step = { readonly kind: "provider" } | { readonly kind: "hub"; readonly returnTo: UsageLoginProvider | null }
  | { readonly kind: "account"; readonly provider: UsageLoginProvider; readonly method: "choose" | "local" | "hub" };

export function UsageAccountDialog({ editHub, provider: preset = null, hub, onHubChanged, onAccountsChanged, onLocalLogin, onClose }: {
  readonly editHub: boolean;
  /** an agent's own Add account or Sign in: the dialog starts at that provider's methods, past the choice of provider */
  readonly provider?: UsageProviderId | null;
  readonly hub: CLIProxyStatus | null;
  readonly onHubChanged: (status: CLIProxyStatus) => void;
  readonly onAccountsChanged: () => void;
  readonly onLocalLogin: (paneId: string) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>(editHub ? { kind: "hub", returnTo: null } : { kind: "provider" });
  const [providers, setProviders] = useState<readonly UsageLoginProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchUsageLoginProviders(controller.signal).then((result) => {
      setProviders(result.providers);
      const named = result.providers.find((candidate) => candidate.id === preset);
      if (named !== undefined && !editHub) setStep((current) => current.kind === "provider" ? { kind: "account", provider: named, method: "choose" } : current);
    })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("Could not load sign-in options")); });
    return () => controller.abort();
  }, [t, preset, editHub]);
  const surface = useFocusTrap<HTMLDivElement>(true);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    (content.current?.querySelector<HTMLElement>("input, button") ?? surface.current)?.focus();
  }, [step, providers, surface]);
  const done = () => { onAccountsChanged(); onClose(); };
  let title: string;
  let body: ReactNode;
  let current: number;
  let steps = [t("Provider"), t("Method"), t("Sign in")];
  let back = () => setStep({ kind: "provider" });
  switch (step.kind) {
    case "provider":
      title = t("Choose a provider"); current = 0;
      body = <div className="account-choices account-provider-grid">
        {error && <p className="settings-hint account-error" role="alert">{error}</p>}
        {!providers && !error && <p className="settings-hint" role="status">{t("Loading…")}</p>}
        {providers?.map((provider) => <button key={provider.id} type="button" className="account-choice" aria-label={PROVIDER_NAME[provider.id]} aria-describedby={`usage-provider-desc-${provider.id}`} onClick={() => setStep({ kind: "account", provider, method: "choose" })}>
          <AgentMark agent={PROVIDER_MARK[provider.id]} size={24} /><span><strong>{PROVIDER_NAME[provider.id]}</strong><span id={`usage-provider-desc-${provider.id}`} className="settings-hint">{provider.id === "claude" || provider.id === "codex" ? t("On this PC or through the hub") : t("On the server PC")}</span></span>
        </button>)}
        <button type="button" className="account-choice" aria-label={t("Hub")} onClick={() => setStep({ kind: "hub", returnTo: null })}><Network size={24} aria-hidden="true" /><span><strong>{t("Hub")}</strong><span className="settings-hint">{t("Import accounts from CLIProxyAPI")}</span></span></button>
      </div>;
      break;
    case "hub":
      title = t("Connect a hub"); current = 1; steps = [t("Provider"), t("Connection")];
      body = <UsageHubConnect hub={hub} onConnected={onHubChanged} onDone={() => {
        onAccountsChanged();
        if (step.returnTo) setStep({ kind: "account", provider: step.returnTo, method: "choose" });
        else onClose();
      }} />;
      if (step.returnTo) back = () => { if (step.returnTo) setStep({ kind: "account", provider: step.returnTo, method: "choose" }); };
      break;
    case "account": {
      const hubProvider = step.provider.id === "claude" || step.provider.id === "codex" ? step.provider.id : null;
      let local: ReactNode = null;
      let showHub = hubProvider !== null;
      let active = false;
      switch (step.method) {
        case "choose":
          title = t("How do you want to sign in?"); current = 1;
          local = !step.provider.installed
            ? <p className="settings-hint">{t("Install {cli} on the server PC first.", { cli: step.provider.cli })}</p>
            : step.provider.local
              ? <button type="button" className="account-choice" onClick={() => setStep({ ...step, method: "local" })}><SquareTerminal size={24} aria-hidden="true" /><span><strong>{t("On this PC")}</strong><span className="settings-hint">{t("Official CLI in a new tab")}</span></span></button>
              : <p className="settings-hint">{t("Sign in from the Antigravity app on the server PC.")}</p>;
          break;
        case "local":
          title = t("Sign in to {provider}", { provider: PROVIDER_NAME[step.provider.id] }); current = 2;
          local = <UsageLocalLogin provider={step.provider} onStarted={onLocalLogin} onFollowed={done} />; showHub = false;
          back = () => setStep({ ...step, method: "choose" });
          break;
        case "hub":
          title = t("Sign in to {provider}", { provider: PROVIDER_NAME[step.provider.id] }); current = 2; active = true;
          back = () => setStep({ ...step, method: "choose" });
          break;
        default: { const unexpected: never = step.method; throw new Error(String(unexpected)); }
      }
      body = <div className="account-choices">
        {local}
        {showHub && hubProvider !== null && (hub?.ok
          ? <CLIProxyAccountLogin provider={hubProvider} active={active} onStarted={() => setStep({ ...step, method: "hub" })} onAccountsChanged={done} />
          : <><button type="button" className="account-choice" disabled><Network size={24} aria-hidden="true" /><span><strong>{t("Through the hub")}</strong></span></button><button className="btn btn-ghost" type="button" onClick={() => setStep({ kind: "hub", returnTo: step.provider })}>{t("Connect a hub first")}</button></>)}
      </div>;
      break;
    }
    default: { const unexpected: never = step; throw new Error(String(unexpected)); }
  }
  return createPortal(<div className="modal-scrim" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <div ref={surface} className="modal usage-account-dialog" role="dialog" aria-modal="true" aria-labelledby="usage-account-title" tabIndex={-1}>
      <div className="modal-header">
        {current > 0 && <button className="icon-button" type="button" aria-label={t("Back")} onClick={back}><ArrowLeft size={18} aria-hidden="true" /></button>}
        <h2 className="modal-title" id="usage-account-title">{title}</h2>
        <button className="icon-button" type="button" aria-label={t("Close")} onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="modal-body">
        <ol className="account-steps" aria-label={t("Account setup")}>{steps.map((label, index) => <li key={label} aria-current={index === current ? "step" : undefined}>{label}</li>)}</ol>
        <div ref={content} className="account-step-content">{body}</div>
      </div>
    </div>
  </div>, document.body);
}
