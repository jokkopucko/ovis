/**
 * Settings → About → Terminals: the move of this PC's whole herdr session to herdr-core, all of it
 * or nothing (shared/runtime-move.ts). One row with a button, only where the server offers the move
 * (read once as About opens). Its dialog previews what every pane becomes and starts the move, then
 * follows it, reading the server every two seconds only while it is open: the wait for busy panes
 * (Cancel ends it), the steps, and the end. A finished move switches the runtime, which the page
 * follows as Settings' own switch does; a rolled-back one names what was not put back, and Try
 * again shows the plan as it stands now.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import "./RuntimeMove.css";

import type { MovePlanResponse } from "../../shared/runtime-move.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { ApiError, cancelMove, fetchBridgeHealth, fetchMovePlan, startMove } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { moveInProgress } from "../lib/runtimeMove.ts";
import { awaitRestart } from "../lib/runtimeSwitch.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { MovingView, PlanView, ResultView, WaitingView } from "./RuntimeMoveViews.tsx";
import { SettingsRow } from "./SettingsControls.tsx";

const POLL_MS = 2000;

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

interface Props {
  /** the boot id of the server the page reads now (any other one after a move is the restarted server) */
  bootId: string | null;
  /** the row stays away while the page waits for a restarted server; an open dialog stays */
  hidden: boolean;
  onServerRestarted?: () => void;
}

export function RuntimeMove({ bootId, hidden, onServerRestarted }: Props) {
  const t = useT();
  const [answer, setAnswer] = useState<MovePlanResponse | null>(null);
  const [open, setOpen] = useState(false);
  const from = useRef<string | null>(bootId);
  const followed = useRef(false);

  useEffect(() => {
    let live = true;
    // an older server (404) or a refused read offers no move; read again for a restarted server
    void fetchMovePlan().then((next) => { if (live) setAnswer(next); }, () => { if (live) setAnswer(null); });
    return () => { live = false; };
  }, [bootId]);

  if (answer === null) return null;
  const { state } = answer.status;
  // a move that just finished is answered by a server no longer offering one: its dialog stays to follow the restart
  if (!answer.available && !open) return null;
  const openDialog = (): void => {
    // the bridge answering now (its boot id needs no herdr): the move's own switch restarts it
    void fetchBridgeHealth().then((health) => { from.current = health.web_ui?.boot_id ?? bootId; }, () => { from.current = bootId; });
    setOpen(true);
  };
  return (
    <>
      {!hidden && answer.available && (
        <SettingsRow label={t("Move everything to herdr-core")} description={t("Every workspace, tab and agent reopens on herdr-core, all at once.")}>
          <button type="button" className="btn" onClick={openDialog}>{state === "waiting" ? t("Waiting…") : state === "moving" ? t("Moving…") : t("Move…")}</button>
        </SettingsRow>
      )}
      {open && (
        <RuntimeMoveDialog answer={answer} onAnswer={setAnswer} onClose={() => setOpen(false)} follow={() => {
          if (followed.current) return;
          followed.current = true;
          paneLifetimes.runtimeSwitched(LOCAL_MACHINE);
          awaitRestart("herdr-core", {
            from: from.current,
            boot: () => fetchBridgeHealth().then((health) => health.web_ui ? { id: health.web_ui.boot_id, accepted: health.accepted === true } : null),
            onBack: () => { paneLifetimes.runtimeSwitched(LOCAL_MACHINE); onServerRestarted?.(); },
          });
        }} onStarted={() => { followed.current = false; }} />
      )}
    </>
  );
}

type View = "plan" | "waiting" | "moving" | "done" | "result";

function RuntimeMoveDialog({ answer, onAnswer, onClose, follow, onStarted }: { answer: MovePlanResponse; onAnswer: (answer: MovePlanResponse) => void; onClose: () => void; follow: () => void; onStarted: () => void }) {
  const t = useT();
  const id = useId();
  const first = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: first });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a rollback the person has read: Try again shows the plan as it stands now
  const [acknowledged, setAcknowledged] = useState(false);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  const { status } = answer;
  const view: View = status.state === "waiting" || status.state === "moving" || status.state === "done" ? status.state
    : (status.state === "rolled_back" || status.state === "interrupted") && !acknowledged ? "result" : "plan";

  useEffect(() => { if (pending) surface.current?.focus(); }, [pending]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);
  // read again all the while the dialog is open: another browser may start or cancel the move
  useEffect(() => {
    let live = true;
    const timer = setInterval(() => {
      void fetchMovePlan().then((next) => { if (live) { onAnswer(next); setError(null); } }, (reason: unknown) => { if (live) setError(said(reason)); });
    }, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [onAnswer]);
  useEffect(() => { if (status.state === "done") follow(); }, [status.state, follow]);
  useEffect(() => { if (!answer.available && status.state !== "done" && !moveInProgress(status)) onClose(); }, [answer.available, status, onClose]);

  const act = async (deed: () => Promise<void>): Promise<void> => {
    setPending(true);
    setError(null);
    try { await deed(); }
    catch (reason: unknown) { setError(said(reason)); }
    finally { setPending(false); }
  };
  const start = (revision: string) => act(async () => {
    try { await startMove(revision); }
    // a refused start (the plan moved on): what the server shows now, under the refusal's words
    catch (reason: unknown) { onAnswer(await fetchMovePlan()); throw reason; }
    setAcknowledged(false);
    onStarted();
    onAnswer(await fetchMovePlan());
  });
  const cancel = () => act(async () => { await cancelMove(); onAnswer(await fetchMovePlan()); });
  const again = () => act(async () => { onAnswer(await fetchMovePlan()); setAcknowledged(true); });

  if (!answer.available) return null;
  const { plan } = answer;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal runtime-move" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-lead`} tabIndex={-1} data-view={view}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Move everything to herdr-core")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} disabled={pending} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          {view === "plan" && <PlanView t={t} plan={plan} leadId={`${id}-lead`} />}
          {view === "waiting" && <WaitingView t={t} plan={plan} leadId={`${id}-lead`} />}
          {view === "moving" && status.state === "moving" && <MovingView t={t} status={status} leadId={`${id}-lead`} />}
          {view === "done" && <p className="runtime-move-lead" id={`${id}-lead`} role="status">{t("Now running on herdr-core. To go back to herdr, switch the runtime again.")}</p>}
          {view === "result" && (status.state === "rolled_back" || status.state === "interrupted") && <ResultView t={t} plan={plan} status={status} leadId={`${id}-lead`} />}
          {error && <p className="runtime-move-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          {view === "plan" && <>
            <button ref={first} type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void start(plan.revision)}>{plan.ready ? t("Move everything") : t("Move everything once all work is done")}</button>
          </>}
          {view === "waiting" && <>
            <button ref={first} type="button" className="btn" disabled={pending} onClick={() => void cancel()}>{t("Cancel")}</button>
            <button type="button" className="btn btn-primary" disabled>{t("Waiting for work to finish…")}</button>
          </>}
          {(view === "moving" || view === "done") && <button ref={first} type="button" className="btn" onClick={onClose}>{t("Close")}</button>}
          {view === "result" && <>
            <button ref={first} type="button" className="btn" disabled={pending} onClick={onClose}>{t("Close")}</button>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void again()}>{t("Try again")}</button>
          </>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

