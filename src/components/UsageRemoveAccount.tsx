import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { ProviderUsage } from "../../shared/protocol.ts";
import { ApiError, removeUsageAccount, restoreUsageAccount } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { PROVIDER_NAME, usageName } from "../lib/usage.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Forget a list entry, not a CLI credential: Restore under Removed from Ovis, or its next followed sign-in, brings it back. */
export function UsageRemoveAccount({ usage }: { readonly usage: ProviderUsage }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = usageName(usage);
  return <>
    <button ref={trigger} type="button" className="icon-button" aria-label={t("Remove {name}", { name })} title={t("Remove {name}", { name })} onClick={() => setConfirm(true)}>
      <Trash2 aria-hidden="true" />
    </button>
    {confirm && <ConfirmDialog title={t("Remove {name}?", { name })}
      body={t("Remove this account from Ovis? Its CLI sign-in and credentials stay on this PC, and Restore under Removed from Ovis brings it back.")}
      confirmLabel={t("Remove")} onClose={() => setConfirm(false)} onConfirm={async () => {
        const parent = trigger.current?.closest<HTMLElement>("[data-section]");
        await removeUsageAccount(usage.key);
        setConfirm(false);
        window.dispatchEvent(new Event("herdr-usage-changed"));
        parent?.focus();
      }} />}
  </>;
}

/** One provider's accounts removed from Ovis that this PC still lists, each with Restore. */
export function UsageRemovedAccounts({ removed }: { readonly removed: readonly ProviderUsage[] }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  if (removed.length === 0) return null;
  const restore = async (usage: ProviderUsage): Promise<void> => {
    setBusy(true);
    setError(null);
    // the row goes once the list is read again: the provider's section keeps the focus
    const parent = list.current?.closest<HTMLElement>("[data-section]");
    try {
      await restoreUsageAccount(usage.key);
      window.dispatchEvent(new Event("herdr-usage-changed"));
      parent?.focus();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.detail : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <div ref={list} className="usage-removed">
    <p className="usage-removed-title">{t("Removed from Ovis")}</p>
    <ul className="agents-accounts" aria-label={t("Removed from Ovis")}>
      {removed.map((usage) => {
        const name = usageName(usage);
        return <li key={usage.key} className="usage-accounts-row">
          <span className="usage-accounts-account" title={usage.account ?? undefined}>{usage.account ?? PROVIDER_NAME[usage.id]}</span>
          <button type="button" className="btn btn-ghost" aria-label={t("Restore {name}", { name })} disabled={busy} onClick={() => void restore(usage)}>{t("Restore")}</button>
        </li>;
      })}
    </ul>
    {error && <p className="settings-hint account-error" role="alert">{error}</p>}
  </div>;
}
