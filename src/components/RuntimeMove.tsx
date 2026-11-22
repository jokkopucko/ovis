/**
 * Its dialog previews what every pane becomes and starts the move, then follows it, reading the
 * server every two seconds only while it is open: the wait for busy panes (Cancel ends it; a shell's
 * command can be ended there, all at once after a confirm, and an agent's pane opened), the steps,
 * and the end.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import "./RuntimeMove.css";

import type { MovePane, MovePlanResponse, MoveStopAllOffer } from "../../shared/runtime-move.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { ApiError, cancelMove, confirmStopAll, fetchBridgeHealth, fetchMovePlan, installHerdrCore, prepareStopAll, startMove, stopMovePane } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { moveInProgress, runningCommands } from "../lib/runtimeMove.ts";
import { awaitRestart } from "../lib/runtimeSwitch.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { MovingView, PlanView, ResultView, WaitingView } from "./RuntimeMoveViews.tsx";
import { SettingsRow } from "./SettingsControls.tsx";

const POLL_MS = 2000;

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

interface Props {
  bootId: string | null;
  hidden: boolean;
  onServerRestarted?: () => void;
  onOpenPane?: (machineId: string, paneId: string) => void;
}

export function RuntimeMove({ bootId, hidden, onServerRestarted, onOpenPane }: Props) {
  const t = useT();
  const [answer, setAnswer] = useState<MovePlanResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const from = useRef<string | null>(bootId);
  const followed = useRef(false);

  useEffect(() => {
    let live = true;
    void fetchMovePlan().then((next) => { if (live) setAnswer(next); }, () => { if (live) setAnswer(null); });
    return () => { live = false; };
  }, [bootId]);

  if (answer === null) return null;
  const { state } = answer.status;
  const openDialog = (): void => {
    void fetchBridgeHealth().then((health) => { from.current = health.web_ui?.boot_id ?? bootId; }, () => { from.current = bootId; });
    setOpen(true);
  };
  if (!answer.available && answer.install && !open) {
    const install = async (): Promise<void> => {
      setInstalling(true);
      setInstallError(null);
      try {
        await installHerdrCore();
        const next = await fetchMovePlan();
        setAnswer(next);
        if (next.available) openDialog();
      } catch (reason: unknown) {
        setInstallError(said(reason));
        void fetchMovePlan().then(setAnswer, () => {});
      } finally {
        setInstalling(false);
      }
    };
    if (hidden) return null;
    return (
      <SettingsRow label={t("Install herdr-core and move everything")}
        description={t("Installs herdr-core {version} into ~/.local/bin, then shows what moves before anything does.", { version: answer.install.version })}
        condition={installError === null ? undefined : <span className="settings-condition" role="alert">{t("Could not install: {detail}", { detail: installError })}</span>}>
        <button type="button" className="btn" disabled={installing} onClick={() => void install()}>{installing ? t("Installing…") : t("Install and move…")}</button>
      </SettingsRow>
    );
  }
  if (!answer.available && !open) return null;
  return (
    <>
      {!hidden && answer.available && (
        <SettingsRow label={t("Move everything to herdr-core")} description={t("Every workspace, tab and agent reopens on herdr-core, all at once, after a list shows what moves. Scrollback and programs running in shells do not come along.")}>
          <button type="button" className="btn" onClick={openDialog}>{state === "waiting" ? t("Waiting…") : state === "moving" ? t("Moving…") : t("Move…")}</button>
        </SettingsRow>
      )}
      {open && (
        <RuntimeMoveDialog answer={answer} onAnswer={setAnswer} onClose={() => setOpen(false)} onOpenPane={onOpenPane ? (paneId) => onOpenPane(LOCAL_MACHINE, paneId) : null} follow={() => {
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

function RuntimeMoveDialog({ answer, onAnswer, onClose, onOpenPane, follow, onStarted }: { answer: MovePlanResponse; onAnswer: (answer: MovePlanResponse) => void; onClose: () => void; onOpenPane: ((paneId: string) => void) | null; follow: () => void; onStarted: () => void }) {
  const t = useT();
  const id = useId();
  const first = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: first });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // End all and move now was pressed: the list the server offered to end, asked once more before anything is ended
  const [confirming, setConfirming] = useState<MoveStopAllOffer | null>(null);
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
  useEffect(() => {
    let live = true;
    const timer = setInterval(() => {
      void fetchMovePlan().then((next) => { if (live) { onAnswer(next); setError(null); } }, (reason: unknown) => { if (live) setError(said(reason)); });
    }, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [onAnswer]);
  useEffect(() => { if (status.state === "done") follow(); }, [status.state, follow]);
  useEffect(() => { if (view !== "waiting") setConfirming(null); }, [view]);
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
    catch (reason: unknown) { onAnswer(await fetchMovePlan()); throw reason; }
    setAcknowledged(false);
    onStarted();
    onAnswer(await fetchMovePlan());
  });
  const cancel = () => act(async () => { await cancelMove(); onAnswer(await fetchMovePlan()); });
  const again = () => act(async () => { onAnswer(await fetchMovePlan()); setAcknowledged(true); });
  const stopping = status.state === "waiting" ? status.stopping ?? [] : [];
  // the command each row shows: the server ends none that runs in its place
  const shown = (pane: MovePane): string | null => pane.verdict.kind === "busy" ? pane.verdict.command : null;
  const stop = (pane: MovePane, force: boolean) => act(async () => { await stopMovePane(pane.pane_id, shown(pane), force); onAnswer(await fetchMovePlan()); });
  const askStopAll = () => act(async () => {
    const offer = await prepareStopAll();
    if (offer.panes.length > 0) setConfirming(offer);
    else onAnswer(await fetchMovePlan());
  });
  // the server ends exactly the list it offered, or refuses when the panes changed: then the person asks again
  const stopAll = (offer: MoveStopAllOffer) => act(async () => {
    setConfirming(null);
    try { await confirmStopAll(offer.token); } finally { onAnswer(await fetchMovePlan()); }
  });

  if (!answer.available) return null;
  const { plan } = answer;
  const untried = runningCommands(plan).filter((pane) => !stopping.some((entry) => entry.pane_id === pane.pane_id)).length;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal runtime-move" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-lead`} tabIndex={-1} data-view={view}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Move everything to herdr-core")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} disabled={pending} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          {view === "plan" && <PlanView t={t} plan={plan} leadId={`${id}-lead`} />}
          {view === "waiting" && <WaitingView t={t} plan={plan} leadId={`${id}-lead`} confirming={confirming ? confirming.panes : null} stopping={stopping} pending={pending} onStop={(pane, force) => void stop(pane, force)} onOpenPane={onOpenPane} />}
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
          {view === "waiting" && (confirming ? <>
            <button ref={first} type="button" className="btn" disabled={pending} onClick={() => setConfirming(null)}>{t("Back")}</button>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={() => void stopAll(confirming)}>{t("End and move")}</button>
          </> : <>
            <button ref={first} type="button" className="btn" disabled={pending} onClick={() => void cancel()}>{t("Cancel")}</button>
            {untried > 0
              ? <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void askStopAll()}>{t("End all and move now")}</button>
              : <button type="button" className="btn btn-primary" disabled>{t("Waiting for work to finish…")}</button>}
          </>)}
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

