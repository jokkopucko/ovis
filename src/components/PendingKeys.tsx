import { useState } from "react";
import { X } from "lucide-react";

import "./PendingKeys.css";

import type { PendingKey } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";

/**
 * Keys that redeemed a code and wait for this PC's screen (device table T71, T72): each shows the fingerprint its
 * device shows too, and the name is the device's own claim. One key is declined at a time; approving happens only
 * in the confirmation on this PC's screen, never from here.
 */
export function PendingKeys({ pending, onDecline }: { pending: readonly PendingKey[]; onDecline: (id: string) => void }) {
  const t = useT();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  if (pending.every((key) => hidden.has(key.id))) return null;
  return (
    <div className="pending-keys">
      <div className="pending-keys-heading">
        <p className="settings-hint">{t("Waiting for this PC's screen. Approve only a key whose fingerprint your device shows too.")}</p>
        <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")}
          onClick={() => setHidden((previous) => new Set([...previous, ...pending.map((key) => key.id)]))}><X /></button>
      </div>
      <ul className="connect-found-list">
        {pending.map((key) => (
          <li key={key.id} className="connect-found-row">
            <span className="connect-found-name">{t("Says it is {name}", { name: key.label })}</span>
            <span className="connect-found-detail pending-key-fingerprint">{key.fingerprint}</span>
            <button type="button" className="btn" onClick={() => onDecline(key.id)}>{t("Decline")}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The device's side while its key waits (T71): the fingerprint this device computed itself from its own pairing
 * target, the PC's challenge and its own key; never a value a PC or relay sent. Null where the PC has no screen
 * proof (macOS, Windows): then there is nothing true to compare, and the device only says to approve on the PC.
 */
export function KeyFingerprintWait({ pc, fingerprint }: { pc: string; fingerprint: string | null }) {
  const t = useT();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="pending-keys" role="status">
      <div className="pending-keys-heading">
        <p>{t("Approve this device on {pc}'s screen", { pc })}</p>
        <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => setHidden(true)}><X /></button>
      </div>
      {fingerprint !== null && <p className="pending-key-fingerprint">{fingerprint}</p>}
      {fingerprint !== null && <p className="settings-hint">{t("The PC shows the same code.")}</p>}
    </div>
  );
}
