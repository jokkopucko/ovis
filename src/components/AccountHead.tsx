import { useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EllipsisVertical, LogOut, Trash2, UserRound, X } from "lucide-react";

import { useHostedSignIn, type HostedSignIn } from "../lib/account/hostedSignIn.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { AccountManageLists } from "./AccountManage.tsx";
import { SignOutEverywhereSays } from "./ListDevices.tsx";
import { otherDevices, shownOf, type EverywhereAsked, type Shown } from "../lib/account/listLeave.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
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

/**
 * Manage account: the account's ways in, its plan and Delete account, in a sheet over Settings. `account`: its id, whose
 * start is shown as `ovis status` shows it, for `ovis add --account` on a PC with no screen.
 */
export function ManageAccountSheet({ onClose, account, children }: { onClose: () => void; account?: string | undefined; children: ReactNode }) {
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
        <div className="modal-body account-manage-body">
          {account !== undefined && <div className="settings-row account-plan-row" data-account-id><span className="settings-label">{t("Account ID")}</span><span className="account-plan" translate="no">{account.slice(0, 12)}</span></div>}
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Manage account for the hosted sign-in: the account's devices and PCs, then Sign out every device and Delete account,
 * each asked twice. Signing every device out signs this one out too, so the sheet then closes with the sign-in. `pcHere`:
 * a PC is open on this page to read the devices from (the start screen has none, so only this device's own row shows).
 * A leave that left PCs keeping this device names them here, after the sign-in it left is gone; with neither, it closes.
 * The leave clears the stored sign-in before it has named them, so the sheet waits for its outcome before closing.
 */
function HostedManageSheet({ signIn, watching, pcHere, onClose }: { signIn: HostedSignIn | null; watching: boolean; pcHere: boolean; onClose: () => void }) {
  const t = useT();
  const [deleting, setDeleting] = useState<"asked" | "out" | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [everywhere, setEverywhere] = useState<"asked" | "out" | null>(null);
  // Sign out every device's question as it was drawn: the press passes on the devices it named and what it was drawn for
  const [question, setQuestion] = useState<EverywhereAsked | null>(null);
  const [everywhereError, setEverywhereError] = useState<string | null>(null);
  const [leaveNote, setLeaveNote] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const gone = signIn === null && leaveNote === null && !leaving;
  useEffect(() => { if (gone) onClose(); }, [gone, onClose]);
  if (gone) return null;
  const leave = async (from: HostedSignIn, shown: Shown): Promise<void> => {
    setLeaving(true);
    try {
      const { left, message } = await from.leave(shown);
      if (!left && message !== null) throw new Error(message);
      if (message === null) onClose(); else setLeaveNote(message);
    } finally { setLeaving(false); }
  };
  const remove = (from: HostedSignIn): void => {
    if (deleting !== "asked") { setDeleting("asked"); setDeleteError(null); return; }
    setDeleting("out");
    void from.deleteAccount().then(setDeleteError, () => setDeleteError(t("The account could not be deleted. Try again."))).finally(() => setDeleting(null));
  };
  const signOutEverywhere = (from: HostedSignIn): void => {
    if (everywhere !== "asked") {
      // the other devices the question names as it is drawn: on an account with a signed list, these and no others leave it first
      const list = pageAccountList();
      setQuestion({ confirmed: list === null ? [] : otherDevices(list.view(), from.account), shown: shownOf(list, from.account) });
      setEverywhere("asked");
      setEverywhereError(null);
      return;
    }
    setEverywhere("out");
    void from.signOutEverywhere(question ?? undefined).then(setEverywhereError, () => setEverywhereError(t("Could not sign out every device. Try again."))).finally(() => setEverywhere(null));
  };
  return (
    <ManageAccountSheet onClose={onClose} account={signIn?.account}>
      {signIn !== null && <AccountManageLists key={signIn.account} account={signIn.account} watching={watching} pcHere={pcHere} onLeave={(shown) => leave(signIn, shown)} />}
      {leaveNote !== null && <p className="settings-condition" role="alert">{leaveNote}</p>}
      {signIn !== null && <div className="settings-item account-sign-out-everywhere">
        {everywhere === "asked" && <SignOutEverywhereSays account={signIn.account} named={question?.confirmed ?? []}><p className="settings-description" role="status" data-testid="sign-out-everywhere-says">{t("Every browser and app is signed out of the account. Devices paired with a PC can still open it, so cut off a lost device with Disconnect.")}</p></SignOutEverywhereSays>}
        <div className="account-delete-actions">
          <button type="button" className={everywhere === "asked" ? "btn btn-danger" : "btn"} data-action="sign-out-everywhere" data-confirm={everywhere === "asked" ? "sign-out-everywhere" : undefined}
            disabled={everywhere === "out"} aria-busy={everywhere === "out" ? "true" : undefined} onClick={() => signOutEverywhere(signIn)}>{everywhere === "asked" ? t("Sign out every device?") : t("Sign out every device")}</button>
          {everywhere === "asked" && <button type="button" className="btn btn-ghost" onClick={() => setEverywhere(null)}>{t("Cancel")}</button>}
        </div>
        {everywhereError !== null && <p className="settings-condition" role="alert">{everywhereError}</p>}
      </div>}
      {signIn !== null && <div className="settings-item account-delete">
        {deleting === "asked" && <p className="settings-description" role="status" data-testid="delete-account-says">{t("This deletes your Ovis account for good: your sign-in methods, your list of PCs and your plan. It cannot be undone. Devices stay paired with your PCs until you revoke them on each PC. A subscription that still renews has to be cancelled first.")}</p>}
        <div className="account-delete-actions">
          <button type="button" className={deleting === "asked" ? "btn btn-danger" : "account-delete-link"} data-action="delete-account" data-confirm={deleting === "asked" ? "delete-account" : undefined}
            disabled={deleting === "out"} aria-busy={deleting === "out" ? "true" : undefined} onClick={() => remove(signIn)}>{deleting === "asked" ? t("Delete account for good?") : t("Delete account")}</button>
          {deleting === "asked" && <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>{t("Cancel")}</button>}
        </div>
        {deleteError !== null && <p className="settings-condition" role="alert">{deleteError}</p>}
      </div>}
    </ManageAccountSheet>
  );
}

/** Settings → Devices and PCs on a PC page the hosted app opened: the hosted sign-in, while there is one, and its Manage account. */
export function HostedAccountGroup({ signIn, watching = false }: { signIn: HostedSignIn | null; watching?: boolean }) {
  const [managing, setManaging] = useState(false);
  const close = useCallback(() => setManaging(false), []);
  if (signIn === null && !managing) return null;
  return (
    <SettingsGroup section="account">
      {signIn !== null && <AccountHead provider={signIn.provider} onSignOut={signIn.signOut} onManage={() => setManaging(true)} />}
      {managing && <HostedManageSheet signIn={signIn} watching={watching} pcHere onClose={close} />}
    </SettingsGroup>
  );
}

/**
 * The hosted app's start screen's ⋮ menu: Forget PCs where My PCs has a PC to forget (`onForgetPcs`, its edit state),
 * and signed in (`account`) who is signed in, Manage account (for an account whose PCs are all off or that has none:
 * remove a dead one, leave, delete the account) and Sign out, acting on the account service with this browser's own
 * sign-in. With neither, no menu.
 */
export function StartScreenAccountMenu({ account = true, onForgetPcs }: { readonly account?: boolean; readonly onForgetPcs?: (() => void) | undefined }) {
  const t = useT();
  const hosted = useHostedSignIn();
  const signIn = account ? hosted : null;
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const close = useCallback(() => setManaging(false), []);
  const closeMenu = useCallback(() => setOpen(false), []);
  const who = signIn === null ? null : (
    <span className="account-who"><ProviderMark provider={signIn.provider} /><span>{t("Signed in with {provider}", { provider: PROVIDER_NAMES[signIn.provider] })}</span></span>
  );
  const items: RowMenuItem[] = [
    ...(onForgetPcs ? [{ id: "forget-pcs", label: t("Forget PCs"), icon: Trash2, run: onForgetPcs }] : []),
    ...(signIn === null ? [] : [
      { id: "manage-account", label: t("Manage account"), icon: UserRound, divider: onForgetPcs !== undefined, run: () => setManaging(true) },
      { id: "sign-out", label: t("Sign out"), icon: LogOut, run: signIn.signOut },
    ]),
  ];
  const title = signIn === null ? t("More") : t("Account");
  return (
    <>
      {items.length > 0 && (
        <button ref={button} type="button" className="icon-button connect-start-menu" data-action="account-menu" aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          <EllipsisVertical aria-hidden="true" />
        </button>
      )}
      {open && items.length > 0 && button.current !== null && (
        <RowMenu anchor={button.current} title={title} header={who} onClose={closeMenu} items={items} />
      )}
      {managing && <HostedManageSheet signIn={signIn} watching={false} pcHere={false} onClose={close} />}
    </>
  );
}

/**
 * More's account on a phone, for the hosted sign-in: who is signed in (it opens the account in Settings, `onAccount`)
 * and Sign out. None while signed out or off the hosted app.
 */
export function hostedAccountItems(signIn: HostedSignIn | null, t: Translate, onAccount: () => void): RowMenuItem[] {
  if (signIn === null) return [];
  return [
    { id: "account", label: t("Signed in with {provider}", { provider: PROVIDER_NAMES[signIn.provider] }), icon: UserRound, divider: true, run: onAccount },
    { id: "sign-out", label: t("Sign out"), icon: LogOut, run: signIn.signOut },
  ];
}
