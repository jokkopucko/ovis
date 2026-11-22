/**
 * A new device asks to join the account through a PC this device is connected to
 * (`remote-pairings`, docs/account.md "Who may admit a device"). The approver picks the number the
 * new device shows out of three, as Microsoft Authenticator's number matching does: a tap without
 * looking is right one time in three, and a wrong pick ends the request. Approve stays off until
 * a number is picked; Deny and Escape end it.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapPin, MonitorSmartphone } from "lucide-react";

import "./AccountApprovalPrompt.css";

import { ACCOUNT_OS_NAMES, placeName, type AccountAsker as Asker } from "../../shared/account-asker.ts";
import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

export interface AccountApprovalPromptProps {
  request: RemotePairingRequest;
  pcName: string;
  pcCount: number;
  /**
   * What the account service saw of the device asking (GET /v1/admissions): undefined while it is
   * read, when Approve waits for it; null for a request for this PC only, which has none.
   */
  asker: Asker | null | undefined;
  onDecide: (decision: "approve" | "decline", digits?: string) => Promise<void>;
}

const grouped = (digits: string): string => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/**
 * Who is asking (docs/account.md): the system the device sent and the place the account service saw
 * its request come from, against a phished device code. An unknown place says so.
 */
export function AccountAsker({ asker, language }: { asker: Asker; language: string }) {
  const t = useT();
  const place = placeName(language, asker);
  const parts = [asker.os === null ? null : ACCOUNT_OS_NAMES[asker.os], place === null ? t("Network location unknown") : t("Network near {place}", { place })];
  return (
    <p className="account-approval-asker" data-place={place === null ? "unknown" : "known"}>
      <MapPin aria-hidden="true" />
      <span>{parts.filter((part) => part !== null).join(" · ")}</span>
    </p>
  );
}

export function AccountApprovalCard({ request, pcName, pcCount, asker, onDecide }: AccountApprovalPromptProps) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const id = useId();
  const deny = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: deny });
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // who-is-asking is read again (the device asked anew): a number picked against the old details goes
  const [readFor, setReadFor] = useState(asker);
  if (readFor !== asker) {
    setReadFor(asker);
    if (asker === undefined) setPicked(null);
  }

  const decide = async (decision: "approve" | "decline"): Promise<void> => {
    setBusy(true);
    setError(null);
    try { await onDecide(decision, decision === "approve" ? picked ?? undefined : undefined); }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
  };

  // Back answers nothing: the request shows by itself, and a Back meant for what was on the screen a
  // moment before must neither deny it nor close what lies under it.
  usePhoneSheetBack(() => false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      void decide("decline");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="modal-scrim">
      <div ref={surface} className="modal account-approval" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-lead ${id}-ask`} tabIndex={-1} data-testid="account-approval">
        <div className="account-approval-mark" aria-hidden="true"><MonitorSmartphone /></div>
        <h2 className="account-approval-title" id={`${id}-title`}>{t("Add a new device?")}</h2>
        <p className="account-approval-lead" id={`${id}-lead`}>{t("Check the number, then approve")}</p>
        <p className="account-approval-via">{request.intent === "account" ? t("Through {pc} · joins your {n} PCs", { pc: pcName, n: pcCount }) : t("Only for {pc}", { pc: pcName })}</p>
        {asker != null && <AccountAsker asker={asker} language={resolvedLanguage} />}
        {/* the name and the system are the device's own word, the place only its network's: said, so neither reads as checked */}
        {asker != null && <p className="account-approval-hint">{t("The name and system are what the device says. The place is where its network connects from.")}</p>}
        <p className="account-approval-ask" id={`${id}-ask`}>{t("Pick the number on {device}", { device: request.label })}</p>
        <div className="account-approval-choices" role="radiogroup" aria-labelledby={`${id}-ask`}>
          {request.choices.map((choice) => (
            <button key={choice} type="button" role="radio" aria-checked={picked === choice} aria-label={choice.split("").join(" ")}
              className="account-approval-choice" disabled={busy || asker === undefined} onClick={() => setPicked(choice)}>{grouped(choice)}</button>
          ))}
        </div>
        {error !== null && <p className="account-approval-error" role="alert">{error}</p>}
        <div className="account-approval-actions">
          <button ref={deny} type="button" className="btn" disabled={busy} onClick={() => void decide("decline")}>{t("Deny")}</button>
          <button type="button" className="btn btn-primary" disabled={busy || picked === null || asker === undefined} onClick={() => void decide("approve")}>{t("Approve")}</button>
        </div>
        <p className="account-approval-note">{t("Approve only if you started this yourself just now. Didn't ask for it? Deny it.")}</p>
      </div>
    </div>
  );
}

export function AccountApprovalPrompt(props: AccountApprovalPromptProps) {
  return createPortal(<AccountApprovalCard {...props} />, document.body);
}
