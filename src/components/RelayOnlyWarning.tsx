import { useState } from "react";
import { TriangleAlert, X } from "lucide-react";

import "./RelayOnlyWarning.css";

import { useT } from "../lib/i18n.ts";

const DISMISSED_KEY = "ovis:relay-only-warning-dismissed";

function readDismissed(): boolean {
  try { return window.localStorage.getItem(DISMISSED_KEY) === "1"; } catch { return false; }
}

function writeDismissed(): void {
  try { window.localStorage.setItem(DISMISSED_KEY, "1"); } catch { }
}

/**
 * Security-triage's CONDITIONAL GO 4 (device table T70): recovery from a stolen older device happens at this PC, so a
 * PC reachable only through the relay needs SSH, a console or a screen kept working. Only while the account opens
 * every PC (account-opens-all/1) and only on a relay-only PC (setupGuideFlow relayOnlyPc); nothing changes with the
 * release off. Its close hides it on this device for good and changes nothing on the PC.
 */
export function RelayOnlyWarning({ opensAll, relayOnly }: { opensAll: boolean; relayOnly: boolean }) {
  const t = useT();
  const [hidden, setHidden] = useState(readDismissed);
  if (!opensAll || !relayOnly || hidden) return null;
  return (
    <div className="relay-only-warning">
      <p className="setup-note"><TriangleAlert aria-hidden="true" />{t("Keep SSH or a screen working on this PC: reached only through the relay, one stolen older device could lock you out of it.")}</p>
      <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { writeDismissed(); setHidden(true); }}><X /></button>
    </div>
  );
}
