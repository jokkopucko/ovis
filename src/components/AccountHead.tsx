import { useContext, useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LogOut, X } from "lucide-react";

import type { HostedSignIn } from "../lib/account/hostedSignIn.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import type { RowMenuItem } from "./RowMenu.tsx";
import { SettingsGroup, SettingsQuery, SettingsRow } from "./SettingsControls.tsx";

/**
 * The account group's one line: who is signed in, Manage account (where the page has it) and Sign out; a settings row of
 * its own while a search runs, which also names the plan.
 */
export function AccountHead({ provider, plan = null, onManage, onSignOut }: { provider: AccountProvider; plan?: string | null; onManage?: () => void; onSignOut: () => void }) {
  const t = useT();
  const searching = useContext(SettingsQuery).length > 0;
  const name = PROVIDER_NAMES[provider];
  if (searching) {
    return (
      <SettingsRow label={t("Signed in with {provider}", { provider: name })} description={plan ?? undefined} keywords={t("Sign out")}>
        <button type="button" className="btn" onClick={onSignOut}>{t("Sign out of {provider}", { provider: name })}</button>
      </SettingsRow>
    );
  }
  return (
    <div className="settings-row account-head">
      <span className="account-who">
        <ProviderMark provider={provider} />
        <span className="settings-label">{t("Signed in with {provider}", { provider: name })}</span>
      </span>
      <span className="account-head-actions">
        {onManage !== undefined && <button type="button" className="btn account-head-btn" data-action="manage-account" onClick={onManage}>{t("Manage account")}</button>}
        <button type="button" className="btn account-head-btn" aria-label={t("Sign out of {provider}", { provider: name })} onClick={onSignOut}>{t("Sign out")}</button>
      </span>
    </div>
  );
}

/** Manage account: the account's ways in, its plan and Delete account, in a sheet over Settings. */
export function ManageAccountSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // a question over the sheet (an alert dialog, a native modal) takes its own Escape
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current) || document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal account-manage-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} data-testid="manage-account">
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Manage account")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body account-manage-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Settings → Devices and PCs on a PC page the hosted app opened: the hosted sign-in, while there is one. */
export function HostedAccountGroup({ signIn }: { signIn: HostedSignIn | null }) {
  if (signIn === null) return null;
  return (
    <SettingsGroup section="account">
      <AccountHead provider={signIn.provider} onSignOut={signIn.signOut} />
    </SettingsGroup>
  );
}

/** More's Sign out on a phone, for the hosted sign-in: none while signed out or off the hosted app. */
export function hostedSignOutItems(signIn: HostedSignIn | null, t: Translate): RowMenuItem[] {
  return signIn === null ? [] : [{ id: "sign-out", label: t("Sign out"), icon: LogOut, divider: true, run: signIn.signOut }];
}
