import { type ReactNode, useState } from "react";
import { QrCode as QrIcon } from "lucide-react";

import "./PhonePanel.css";

import { copyText } from "../lib/clipboard.ts";
import { QrCode } from "./QrCode.tsx";
import { useT } from "../lib/i18n.ts";
import { ExternalLink } from "../lib/externalLink.ts";

export function PhonePanel({ url, phone = false }: { url: string; phone?: boolean }) {
  const t = useT();
  return (
    <div className="phone-panel">
      {phone ? (
        <div className="phone-address phone-address-phone">
          <p className="phone-url"><ExternalLink kind="ovis" href={url}>{url}</ExternalLink></p>
          <ShareLink url={url} copyLabel={t("Copy address")} />
          <QrReveal value={url} label={`QR code: ${url}`} />
        </div>
      ) : <Address url={url} />}
    </div>
  );
}

export function Address({ url, title }: { url: string; title?: string }) {
  return (
    <div className="phone-address">
      <QrCode value={url} label={`QR code: ${url}`} />
      <div>
        {title !== undefined && <p className="settings-label">{title}</p>}
        <p className="phone-url"><ExternalLink kind="ovis" href={url}>{url}</ExternalLink></p>
      </div>
    </div>
  );
}

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
          <p className="phone-url"><ExternalLink kind="ovis" href={url}>{url}</ExternalLink></p>
        </>
      )}
    </>
  );
}

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
