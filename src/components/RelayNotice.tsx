import { X } from "lucide-react";

import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import type { RelayNoticeInfo } from "../lib/relayNotice.ts";

import "./LanExposureNotice.css";

export function relayNoticeText(t: Translate, notice: RelayNoticeInfo, locale?: string): { text: string; actionLabel: string } {
  switch (notice.kind) {
    case "sign-in-grace":
      return {
        text: notice.enforceAt !== null
          ? t("Sign in to keep using the Ovis relay after {date}. Same Wi-Fi, Tailscale and your own relay keep working without an account.", { date: new Date(notice.enforceAt).toLocaleDateString(locale) })
          : t("Sign-in will be required for the Ovis relay. Same Wi-Fi, Tailscale and your own relay keep working without an account."),
        actionLabel: t("Sign in"),
      };
    case "sign-in-required":
      return {
        text: t("The Ovis relay needs an Ovis account. Sign in, or connect over the same Wi-Fi or Tailscale."),
        actionLabel: t("Sign in"),
      };
    case "not-listed":
      return {
        text: t("Add this PC to your Ovis account to use the Ovis relay, or connect over the same Wi-Fi or Tailscale."),
        actionLabel: t("Account"),
      };
    case "pc-limit":
      return {
        text: t("This account has reached its PC limit on the Ovis relay. Remove a PC you no longer use, or connect over the same Wi-Fi or Tailscale."),
        actionLabel: t("Devices and PCs"),
      };
    case "data-limit":
      return {
        text: t("This account has reached its relay data limit for new connections. Existing sessions stay open, or connect over the same Wi-Fi or Tailscale."),
        actionLabel: t("Devices and PCs"),
      };
  }
}

/**
 * Over the pane when this PC uses the Ovis-hosted relay without a signed-in account, or when its
 * account's relay pass reports not_listed, limit or new_sessions: false. Dismissible like
 * LanExposureNotice's direct line (useRelayNotice).
 */
export function RelayNotice({ notice, onOpen, onDismiss }: { notice: RelayNoticeInfo; onOpen: () => void; onDismiss: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { text, actionLabel } = relayNoticeText(t, notice, locale);
  return (
    <div className="update-notice" role="status" data-testid="relay-notice" data-relay-notice={notice.kind}>
      <span>{text}</span>
      <div className="lan-exposure-actions">
        <button type="button" className="btn" onClick={onOpen}>{actionLabel}</button>
        <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={onDismiss}><X /></button>
      </div>
    </div>
  );
}
