import { BellOff, X } from "lucide-react";
import { useT, type Translate } from "../lib/i18n.ts";
import { dismissPushNotice, repairFailed, usePushHealth, type PushActionResult } from "../lib/pushHealth.ts";

import "./PushHealthNotice.css";

/** Brave's push service is off until its own setting turns it on. */
export function repairFailureText(t: Translate, result: PushActionResult | null): string | null {
  if (!repairFailed(result)) return null;
  if (result === "no-worker") return t("This page's service worker is not running, so it cannot make a push subscription. Reload the page, then try again.");
  if (result === "unregistered") return t("The PC did not take this device's push subscription. Try again.");
  return typeof navigator !== "undefined" && "brave" in navigator
    ? t("Brave would not make a push subscription. Turn on Use Google services for push messaging in Brave's privacy settings, then try again.")
    : t("This device would not make a push subscription. Check that push messaging is allowed in its settings, then try again.");
}

export function PushHealthNotice({ onRepair, onOpen }: { onRepair: () => void; onOpen: () => void }) {
  const t = useT();
  const { health, busy, result, dismissed } = usePushHealth();
  if (health.problem === null || health.problem === "permission" || health.problem === dismissed) return null;
  const failure = repairFailureText(t, result);
  const text = failure
    ?? (health.problem === "gone" ? t("The push service retired this device's subscription. Turn alerts on again to make a new one.")
      : health.problem === "missing" ? t("This device's push subscription is missing. Turn alerts on again.")
      : health.problem === "key-mismatch" ? t("This device's push subscription was made for another server key. Turn alerts on again to make a new one.")
      : t("The push service refused the last alert to this device. Send a test to check whether it still does."));
  return (
    <div className={`update-notice is-line is-alerts${failure !== null ? " is-failure" : ""}`} role="status" data-testid="push-health-notice" data-problem={health.problem} data-result={result ?? undefined}>
      <BellOff aria-hidden="true" />
      <span title={text}>{text}</span>
      {health.repair
        ? <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={onRepair}>{busy === "repair" ? t("Turning alerts on…") : t("Turn alerts on again")}</button>
        : <button type="button" className="btn" onClick={onOpen}>{t("Alerts")}</button>}
      <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={dismissPushNotice}><X /></button>
    </div>
  );
}
