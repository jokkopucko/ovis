import { useContext, useRef } from "react";
import { BellRing } from "lucide-react";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { inNativeApp } from "../lib/nativeApp.ts";
import { notificationState } from "../lib/notifications.ts";
import { pushSupported, testDevicePush } from "../lib/push.ts";
import { repairFailed, runPushAction, usePushHealth, type PushActionOutcome, type PushActionResult } from "../lib/pushHealth.ts";
import { repairOutcome } from "../lib/useNotifications.ts";
import { useSettings } from "../lib/settings.ts";
import { repairFailureText } from "./PushHealthNotice.tsx";
import { SettingsBare } from "./SettingsControls.tsx";

export function PushTestControls({ onEnable }: { onEnable: () => Promise<PushActionResult> }) {
  const { settings } = useSettings();
  const t = useT();
  const bare = useContext(SettingsBare);
  // the same state as the notice over the pane (lib/pushHealth.ts): one fault, one repair, wherever it is read
  const { health, busy, result } = usePushHealth();
  const wanted = useRef(settings.alertsOn);
  wanted.current = settings.alertsOn;
  const supported = pushSupported();
  const denied = notificationState() === "denied";
  const enable = !settings.alertsOn || health.repair || repairFailed(result) || result === "missing" || result === "gone" || result === "permission";

  const send = (repair: boolean) => runPushAction(repair ? "repair" : "test", async (): Promise<PushActionOutcome> => {
    // the subscription the line will be about: the one tested, or the one the repair registered; none
    // held when the test found none, and unknown (the next look's) when the action stopped before it knew
    let endpoint: string | undefined;
    try {
      if (repair) return repairOutcome(await onEnable());
      const result = await testDevicePush((tested) => { endpoint = tested; });
      return { result, endpoint: result === "missing" ? null : endpoint };
    } catch (error) {
      // gone: the push service retired the endpoint; Turn alerts on again subscribes this device anew
      const code = error instanceof ApiError ? error.code : null;
      // a watching device may receive alerts but never send one: the line says so, and Send test stays unavailable
      const result: PushActionResult = code === "subscription_not_found" ? "missing" : code === "subscription_gone" ? "gone" : code === "read_only" ? "read-only" : "failed";
      return { result, endpoint };
    }
  }, () => wanted.current);

  const hint = !supported || result === "unsupported" ? t("Push alerts need HTTPS or localhost, and on iPhone the home-screen app.")
    : denied ? inNativeApp() ? t("Allow notifications for Ovis in the phone's Settings, then try again.") : t("Allow notifications in your browser settings, then try again.")
    : result === "sent" ? t("Test notification sent. Check this device for the alert.")
    // a repair that failed says why before the fault it did not mend
    : repairFailureText(t, result) ?? (result === "missing" || health.problem === "missing" ? t("This device's push subscription is missing. Turn alerts on again.")
    : result === "gone" || health.problem === "gone" ? t("The push service retired this device's subscription. Turn alerts on again to make a new one.")
    : result === "permission" ? t("Allow notifications to test alerts on this device.")
    : result === "read-only" ? t("This device can only watch.")
    : result === "failed" ? t("Could not send the test notification. Try again.")
    : health.problem === "key-mismatch" ? t("This device's push subscription was made for another server key. Turn alerts on again to make a new one.")
    : health.problem === "rejected" ? t("The push service refused the last alert to this device. Send a test to check whether it still does.")
    : health.transient !== null ? t("The last alert did not reach this device; the next one is tried as usual. Send a test to check.")
    : !settings.alertsOn ? t("Alerts off") : null);

  return (
    <div className="settings-item">
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-label-line"><BellRing className="settings-row-icon" aria-hidden="true" /><span className="settings-label">{t("Test notification")}</span></span>
          {!bare && <span className="settings-description">{t("Check whether this device can receive push alerts")}</span>}
          {/* always in the document, empty until there is something to say: a live region */}
          <span className="settings-hint" role="status" data-testid="push-health-hint">{hint}</span>
        </div>
        <button type="button" className="btn" disabled={busy !== null || !settings.alertsOn || !supported || denied || result === "read-only"} onClick={() => void send(false)}>{busy === "test" ? t("Sending…") : t("Send test")}</button>
      </div>
      {enable && supported && !denied && <div className="settings-actions">
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void send(true)}>{busy === "repair" ? t("Turning alerts on…") : t("Turn alerts on again")}</button>
      </div>}
    </div>
  );
}
