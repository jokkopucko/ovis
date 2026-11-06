import type { Translate } from "./i18n.ts";
import type { NotificationState } from "./notifications.ts";
import { pushSupported } from "./push.ts";

export interface AlertsBellParams {
  t: Translate;
  alertsOn: boolean;
  notifications: NotificationState;
  pushOn: boolean;
  enableNotifications: () => Promise<unknown>;
  disableNotifications: () => Promise<unknown>;
}

/** What the Alerts item in the header's More menu shows and does. */
export function alertsBell({ t, alertsOn, notifications, pushOn, enableNotifications, disableNotifications }: AlertsBellParams) {
  // The Alerts item says what this device does, whatever the browser's permission: in-app alerts
  // need none, so they count as on. A device that has not answered the permission question is
  // asked by the item; one that has answered gets a plain switch.
  const bell: { state: string; title: string; on: boolean; run: () => Promise<unknown> } =
    !alertsOn
      ? { state: t("Off on this device"), title: t("Alerts off on this device. Tap to turn them on"), on: false, run: enableNotifications }
      : notifications !== "granted"
        ? notifications === "default"
          ? { state: t("On in the app"), title: t("Alerts on in the app. Tap to allow them when it is closed too"), on: true, run: enableNotifications }
          : { state: t("On in the app"), title: t("Alerts on in the app. Tap to turn them off"), on: true, run: disableNotifications }
        : pushOn
          ? { state: t("On, pushed to this device"), title: t("Alerts on, pushed to this device, even with the app closed. Tap to turn them off"), on: true, run: disableNotifications }
          : {
              state: t("On in this tab"),
              // turning them off and on again retries the push subscription
              title: pushSupported()
                ? t("Alerts on while this tab is open. Tap to turn them off")
                : t("Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off"),
              on: true,
              run: disableNotifications,
            };
  // the menu's button carries a dot while alerts are off here: the one state of the menu worth a glance
  const alertsOffDot = !bell.on;
  return { bell, alertsOffDot };
}
