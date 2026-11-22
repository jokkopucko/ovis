import { useState } from "react";
import { Copy, RefreshCw } from "lucide-react";

import "./CompactPair.css";

import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { QrCode } from "./QrCode.tsx";

const QR_SIZE = 132;

export function CompactPair({ qr, qrLabel, code, shown = code, codeLabel, busy = false, qrNote, onRefresh }: {
  qr: string | null; qrLabel: string; code: string | null; shown?: string | null; codeLabel: string; busy?: boolean; qrNote?: string; onRefresh: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (code === null) return;
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="compact-pair">
      {qr !== null ? <QrCode value={qr} label={qrLabel} size={QR_SIZE} />
        // a code with no address to put in a QR code stands alone: no empty box beside it
        : qrNote !== undefined || busy || code === null ? <div className="compact-pair-qr-empty" role="status">{qrNote ?? (busy ? t("Getting a code…") : "")}</div> : null}
      <div className="compact-pair-side">
        <p className="compact-pair-code" aria-label={codeLabel} aria-live="polite">{shown ?? "…"}</p>
        <div className="compact-pair-actions">
          <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={onRefresh}><RefreshCw aria-hidden="true" />{t("Refresh")}</button>
          <button type="button" className="btn" disabled={code === null} onClick={copy}><Copy aria-hidden="true" />{copied ? t("Copied") : t("Copy")}</button>
        </div>
      </div>
    </div>
  );
}
