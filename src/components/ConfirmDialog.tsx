/**
 * A yes-or-no question before something that cannot be undone. Cancel takes the focus, so Enter
 * answers no; Escape and the scrim answer no as well, and Tab stays between the two buttons.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./ConfirmDialog.css";

import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  escalation?: { label: string; code: string; run: () => Promise<void> };
  onClose: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, escalation, onClose }: Props) {
  const t = useT();
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: cancel, shouldRestore: () => !done.current });
  const [pending, setPending] = useState(false);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  const [error, setError] = useState<string | null>(null);
  const [escalated, setEscalated] = useState(false);

  // both buttons disable while the deed runs, which would drop the focus into the page: the
  // dialog itself holds it, and Tab stays put until the dialog goes
  useEffect(() => { if (pending) surface.current?.focus(); }, [pending]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);

  const confirm = async (): Promise<void> => {
    setPending(true);
    setError(null);
    const deed = escalated && escalation ? escalation.run : onConfirm;
    try { await deed(); done.current = true; }
    catch (reason: unknown) {
      setError(reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason));
      if (!escalated && escalation && reason instanceof ApiError && reason.code === escalation.code) setEscalated(true);
      setPending(false);
    }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{title}</h2></header>
        <div className="modal-body">
          <p className="confirm-body" id={`${id}-body`}>{body}</p>
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button ref={cancel} type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button ref={action} type="button" className="btn btn-danger" disabled={pending} onClick={() => void confirm()}>{escalated && escalation ? escalation.label : confirmLabel}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
