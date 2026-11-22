import { useEffect, useState } from "react";
import { Bell, Info } from "lucide-react";
import { useT } from "../lib/i18n.ts";

export const ALERTS_CHECK_GIVE_UP_MS = 15_000;

export function useLongerThan(on: boolean, ms: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    setPast(false);
    if (!on) return;
    const timer = window.setTimeout(() => setPast(true), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return on && past;
}

/**
 * The guide's alerts while the PC's record of this browser's subscription is not in (lib/setupGuideFlow.ts alertsHere
 * "checking"): Checking…, then past the bound a line that it could not be checked and Try again (a look, never a
 * request), so a user is never left with no word and no button.
 */
export function AlertsChecking({ uncheckable, onRetry }: { uncheckable: boolean; onRetry: () => void }) {
  const t = useT();
  if (!uncheckable) return <p className="setup-note"><Info aria-hidden="true" />{t("Checking…")}</p>;
  return (
    <>
      <p className="setup-note"><Info aria-hidden="true" />{t("Couldn't check alerts.")}</p>
      <div className="setup-actions">
        <button type="button" className="btn" onClick={onRetry}><Bell aria-hidden="true" />{t("Try again")}</button>
      </div>
    </>
  );
}
