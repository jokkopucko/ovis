/**
 * The alarm of the account's signed list on this device (docs/account-list.md, "Two histories"): it was shown two
 * versions of the list, each signed by a member, by the account service or by a PC it met. It names nobody as the
 * cause, since a member signs twice at one place honestly and whoever holds both versions chooses whom to show which.
 * It says what still works (whoever was in keeps working), what stops (nobody new is let in from this device), and the
 * way back one device or PC at a time, never "remove it here, then reset the others": a removal signed on one version
 * does nothing on the other.
 */
import { useEffect, useState } from "react";
import type { AccountListView } from "../lib/account/accountList.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import "./ListAlarmNotice.css";

const alarmed = (view: AccountListView | undefined, account: string | undefined): boolean =>
  view !== undefined && (account === undefined || view.account === account) && view.status.at === "following" && view.status.trouble === "fork";

/** Whether this page's copy of the account's list holds the alarm: of `account`, or of whichever account it follows when none is named. */
function useListAlarm(account: string | undefined): boolean {
  const [alarm, setAlarm] = useState(() => alarmed(pageAccountList()?.view(), account));
  useEffect(() => {
    const list = pageAccountList();
    setAlarm(alarmed(list?.view(), account));
    return list?.subscribe((view) => { setAlarm(alarmed(view, account)); });
  }, [account]);
  return alarm;
}

/** Manage account's part for the alarm, over its lists of devices and PCs; nothing while there is none. */
export function ListAlarmNotice({ account }: { readonly account?: string }) {
  const t = useT();
  if (!useListAlarm(account)) return null;
  return (
    <section className="account-manage-part account-list-alarm" role="status" aria-label={t("Two different histories of your account's list were seen")} data-list-alarm="">
      <h3 className="account-manage-h account-list-alarm-title">{t("Two different histories of your account's list were seen")}</h3>
      <p className="settings-hint">{t("This device was shown two versions of your account's list. Devices and PCs already in your account keep working. While this shows, this device lets nobody new in.")}</p>
      <p className="settings-hint">{t("To fix it, go one device or PC at a time:")}</p>
      <ol className="account-list-alarm-steps settings-hint">
        <li>{t("Reset one. On a device, sign out, sign in again and allow it from another device or PC, then remove its old listing there. On a PC, choose Revoke all, then add it to your account again.")}</li>
        <li>{t("Look at the devices and PCs it shows, and remove any that is not yours on that same device or PC.")}</li>
        <li>{t("Check that it is gone there before you reset the next one.")}</li>
        <li>{t("If two of them still show different devices and PCs, stop: resetting more of them does not fix it.")}</li>
      </ol>
    </section>
  );
}

/** My PCs' one line for the alarm, pointing to Manage account; nothing while there is none. */
export function ListAlarmLine({ account }: { readonly account?: string }) {
  const t = useT();
  if (!useListAlarm(account)) return null;
  return (
    <p className="account-error relay-add-directory-error" role="status" data-list-alarm="">
      {t("Two different histories of your account's list were seen. Nobody new is let in from this device. Open Manage account to see what to do.")}
    </p>
  );
}
