import { useEffect, useState, type ReactNode } from "react";
import { Smartphone, SmartphoneNfc, X } from "lucide-react";

import "./DevicePairedNotice.css";

import type { DevicePairedEvent, DeviceRemovedEvent } from "../../shared/protocol.ts";
import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import { keyFingerprint, TOLD_KINDS } from "../lib/deviceNotices.ts";
import { currentLocale, useT } from "../lib/i18n.ts";

const METHOD_NAMES = { github: "GitHub", google: "Google", apple: "Apple" } as const;

/**
 * One PC's journal notices (device table P10, T34, T57, T58): who joined, how they signed in, and their key.
 * Two-step sign-in is said as the account record states it, never as used. Hiding an undecided admission
 * leaves its PC's decision untouched; `actions` adds that PC's answers to it.
 */
export function DeviceNotices({ pc, notices, cut = 0, onDismiss, onHide, onShown, actions }: { pc: string; notices: readonly DeviceNotice[]; cut?: number; onDismiss: (notice: DeviceNotice) => void; onHide?: (notice: DeviceNotice) => void; onShown?: (seq: number) => void; actions?: (notice: DeviceNotice) => ReactNode }) {
  const t = useT();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const shown = notices.filter((notice) => TOLD_KINDS.has(notice.kind));
  const newest = shown.reduce((seq, notice) => Math.max(seq, notice.seq), 0);
  useEffect(() => { if (newest > 0) onShown?.(newest); }, [newest, onShown]);
  return <>{cut > 0 && <p className="settings-hint">{cut === 1 ? t("An older notice from {pc} was cleared before this device saw it.", { pc }) : t("{count} older notices from {pc} were cleared before this device saw them.", { count: cut, pc })}</p>}{shown.filter((notice) => !hidden.has(notice.id)).map((notice) => {
    const time = new Date(notice.at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
    const method = notice.method === null ? null : METHOD_NAMES[notice.method];
    const headline = notice.kind === "method" ? t("A sign-in method was added to your account at {time}.", { time })
      : method === null ? t("{time}: a new device was added on {pc}: {name}", { time, pc, name: notice.label })
      : t("{time}: a new device joined {pc}: {name}", { time, pc, name: notice.label });
    let how: string | null;
    switch (notice.two_step) {
      case "verified":
        how = method === null ? null : t("{method} sign-in, two-step sign-in verified", { method });
        break;
      case "set":
        how = method === null ? t("Two-step sign-in set on the account") : t("{method} sign-in, two-step sign-in set on the account", { method });
        break;
      default:
        // Older or newer PC notices may omit the field or send an unrecognised wire value.
        how = method !== null ? t("{method} sign-in, two-step sign-in not confirmed", { method })
          : notice.two_step === null || (notice.two_step === undefined && notice.how !== "list") ? null
          : t("Two-step sign-in not confirmed");
    }
    return (
      <div key={notice.id} className="update-notice is-paired device-notice" role="status" data-testid="device-notice">
        <Smartphone aria-hidden="true" />
        <span className="device-notice-text">
          <span>{headline}</span>
          {how !== null && <span className="settings-hint">{how}</span>}
          {notice.kind === "admit" && notice.key !== null && <span className="settings-hint">{t("Key {fingerprint}", { fingerprint: keyFingerprint(notice.key) })}</span>}
        </span>
        <div className="device-paired-actions">
          {actions?.(notice)}
          <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => {
            if (onHide !== undefined) onHide(notice);
            else if (notice.open) setHidden((previous) => new Set([...previous, notice.id]));
            if (!notice.open) onDismiss(notice);
          }}><X /></button>
        </div>
      </div>
    );
  })}</>;
}

/**
 * The owner pairing their own phone is the usual case, and the line is calm for it; the words carry
 * the warning for the other case, so no colour has to: if that was not you, revoke it.
 */
export function DevicePairedNotice({ events, onOpen, onDismiss }: { events: readonly DevicePairedEvent[]; onOpen: (event: DevicePairedEvent) => void; onDismiss: (event: DevicePairedEvent) => void }) {
  const t = useT();
  return <>{events.map((event) => {
    const time = new Date(event.enrolled_at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
    return (
      <div key={event.event_id} className="update-notice is-paired" role="status" data-testid="device-paired-notice">
        <Smartphone aria-hidden="true" />
        <span>{event.approved_by
          ? t("A new device joined at {time}: {name}, approved on {approver}. If that was not you, revoke it.", { time, name: event.label, approver: event.approved_by.label })
          : t("A new device was paired at {time}: {name}. If that was not you, revoke it.", { time, name: event.label })}</span>
        <div className="device-paired-actions">
          <button type="button" className="btn" onClick={() => onOpen(event)}>{t("Devices and PCs")}</button>
          <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => onDismiss(event)}><X /></button>
        </div>
      </div>
    );
  })}</>;
}

/**
 * A device was removed from this PC while this window was open (`device-removed`): revoked here,
 * or removed through the account by another device. One calm line per removal, saying by whom, so
 * a removal nobody here made shows; dismissed by hand.
 */
export function DeviceRemovedNotice({ events, onDismiss }: { events: readonly DeviceRemovedEvent[]; onDismiss: (event: DeviceRemovedEvent) => void }) {
  const t = useT();
  return <>{events.map((event) => {
    const time = new Date(event.removed_at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
    const text = event.by === undefined ? t("{name} was removed from this PC at {time}.", { name: event.label, time })
      : event.by === "pc" ? t("{name} was revoked on this PC at {time}.", { name: event.label, time })
      : t("{name} was removed from this PC at {time}, by {by}.", { name: event.label, time, by: event.by.label });
    return (
      <div key={event.event_id} className="update-notice is-paired" role="status" data-testid="device-removed-notice">
        <SmartphoneNfc aria-hidden="true" />
        <span>{text}</span>
        <div className="device-paired-actions">
          <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => onDismiss(event)}><X /></button>
        </div>
      </div>
    );
  })}</>;
}
