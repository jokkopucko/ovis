import { type ReactNode, useRef, useState } from "react";
import { QrCode as QrIcon, RefreshCw } from "lucide-react";

import "./PhonePanel.css";

import { copyText } from "../lib/clipboard.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { QrCode } from "./QrCode.tsx";
import { useT } from "../lib/i18n.ts";

const README_PHONE = "https://github.com/devswha/ovis#on-your-phone";

export interface PhonePanelProps {
  plan: PhonePlan;
  /** the server is still being asked */
  loading: boolean;
  onRefresh: () => void;
  /** shown on a phone: the address to copy or share, its QR code behind Show QR code */
  phone?: boolean;
}

/** Settings → Phone & devices → Connect a phone → Tailscale: the address a phone can open, or the one step still missing on this PC. */
export function PhonePanel({ plan, loading, onRefresh, phone = false }: PhonePanelProps) {
  const t = useT();
  return <div className="phone-panel">{loading && plan.kind !== "here" ? <p className="settings-hint" role="status">{t("Asking this PC about Tailscale…")}</p> : <Plan plan={plan} loading={loading} onRefresh={onRefresh} phone={phone} />}</div>;
}

function Plan({ plan, loading, onRefresh, phone }: PhonePanelProps) {
  const t = useT();
  const checkAgain = <button type="button" className="btn" onClick={onRefresh} disabled={loading}><RefreshCw aria-hidden="true" />{t("Check again")}</button>;
  switch (plan.kind) {
    case "here":
    case "served":
      return (
        <>
          {phone
            ? <PhoneAddress url={plan.url} title={t(plan.kind === "here" ? "This page's address, for your other devices" : "Tailscale already serves this PC")} />
            : <Address url={plan.url} title={t(plan.kind === "here" ? "Open this address on your phone" : "Tailscale already serves this PC")} />}
          <p className="settings-description">{t("Once it is open, install the app, then open the ⋯ menu and tap Alerts.")}</p>
        </>
      );
    case "command":
      return (
        <>
          <p className="settings-description">{t("In a terminal on this PC, publish the app to your tailnet. Only devices in your tailnet can open the address.")}</p>
          <Command command={plan.command} />
          {plan.url !== null && <p className="settings-description">{t("It will be at {url}.", { url: plan.url })}</p>}
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
    case "stopped":
      return (
        <>
          <p className="settings-description">{t("Tailscale is on this PC but not connected. Run tailscale up there, then check again.")}</p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
    case "missing":
      return (
        <>
          <p className="settings-description">{t("Tailscale is the shortest route: install it on this PC, run tailscale up, then check again. An SSH tunnel or your own HTTPS proxy work too.")}</p>
          <p className="settings-description"><a href="https://tailscale.com/download" target="_blank" rel="noreferrer">{t("Get Tailscale")}</a> · <a href={README_PHONE} target="_blank" rel="noreferrer">{t("Other routes")}</a></p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
    default:
      return (
        <>
          <p className="settings-description">{t("This PC did not say how it can be reached.")} <a href={README_PHONE} target="_blank" rel="noreferrer">{t("Other routes")}</a></p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
  }
}

export function Address({ url, title }: { url: string; title: string }) {
  return (
    <div className="phone-address">
      <QrCode value={url} label={`QR code: ${url}`} />
      <div>
        <p className="settings-label">{title}</p>
        <p className="phone-url"><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      </div>
    </div>
  );
}

/**
 * The address on the phone itself: there is no camera to point at the screen it is shown on, so the
 * address is read, copied or shared, and its QR code, for another device's camera, waits behind
 * Show QR code.
 */
function PhoneAddress({ url, title }: { url: string; title: string }) {
  const t = useT();
  return (
    <div className="phone-address phone-address-phone">
      <p className="settings-label">{title}</p>
      <p className="phone-url"><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      <ShareLink url={url} copyLabel={t("Copy address")} />
      <QrReveal value={url} label={`QR code: ${url}`} />
    </div>
  );
}

/** Share (where the browser can) and Copy for a link; Copy says Copied for a moment once it worked. */
export function ShareLink({ url, copyLabel, children }: { url: string; copyLabel: string; children?: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const copy = async () => {
    setFailed(false);
    if (!(await copyText(url))) { setFailed(true); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <>
      <div className="phone-actions phone-share">
        {canShare && <button type="button" className="btn" onClick={() => { navigator.share({ url }).catch(() => undefined); }}>{t("Share link")}</button>}
        <button type="button" className="btn" onClick={() => void copy()}>{copied ? t("Copied") : copyLabel}</button>
        {children}
      </div>
      {failed && (
        <>
          <p className="settings-hint" role="alert">{t("This browser would not copy it. Press and hold the link to copy it.")}</p>
          <p className="phone-url"><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
        </>
      )}
    </>
  );
}

/** A QR code drawn only once asked for: on a phone it is for another device's camera, not the reader's. */
export function QrReveal({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="qr-reveal">
      <button type="button" className="btn btn-ghost qr-reveal-toggle" aria-expanded={shown} onClick={() => setShown((value) => !value)}>
        <QrIcon aria-hidden="true" />{t(shown ? "Hide QR code" : "Show QR code")}
      </button>
      {shown && (
        <div className="qr-reveal-body">
          <QrCode value={value} label={label} />
          {hint !== undefined && <p className="settings-description">{hint}</p>}
        </div>
      )}
    </div>
  );
}

function Command({ command }: { command: string }) {
  const t = useT();
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(command, codeRef.current))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="phone-command">
      <code ref={codeRef}>{command}</code>
      <button type="button" className="btn" onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
    </div>
  );
}
