import { useState } from "react";

import { useT, type Translate } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SettingsRow } from "./SettingsControls.tsx";

/**
 * What Sign out says of the way back in, which depends on how the browser got in: a token or a
 * pairing code, or, for a visitor Portal's own sign-in let in (`viaPortal`), Portal's sign-in again.
 * With a Google or company login (`oidc`) that sign-in can pass without a word: Portal asks the provider
 * with no `prompt` or `max_age`, so a browser still signed in there is let straight back in, and Sign out
 * looks like it did nothing. The confirmation says so.
 */
export function wayBackIn(t: Translate, viaPortal: boolean, oidc = false): { row: string; confirm: string } {
  return viaPortal
    ? { row: t("Forget this browser's sign-in. Getting back in means signing in through Portal again."), confirm: oidc ? t("Getting back in means signing in through Portal again. While this browser is still signed in to Google or your company's login, that sign-in lets it straight back in: sign out there too.") : t("Getting back in means signing in through Portal again.") }
    : { row: t("Forget this browser's sign-in. Getting back in takes the access token or a pairing code."), confirm: t("Getting back in takes the access token, or a pairing code from the PC: Settings → Phone & devices there, or the pair command in its terminal.") };
}

/** Settings → Phone & devices → Devices → Sign out: forget this browser's sign-in, after asking once. */
export function SignOutRow({ viaPortal, oidc = false, onSignOut }: { viaPortal: boolean; oidc?: boolean; onSignOut: () => Promise<void> }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const words = wayBackIn(t, viaPortal, oidc);
  return (
    <>
      <SettingsRow label={t("Sign out")} description={words.row}>
        <button type="button" className="btn" onClick={() => setConfirming(true)}>{t("Sign out")}</button>
      </SettingsRow>
      {confirming && <ConfirmDialog title={t("Sign out of this browser?")} body={words.confirm} confirmLabel={t("Sign out")} onClose={() => setConfirming(false)} onConfirm={onSignOut} />}
    </>
  );
}
