/** Add-a-PC modal sheet: four steps, labeled digit input, 90-second wait bound, and docked mobile footer. */
// allow: SIZE_OK — cohesive 4-step modal sheet state machine (new/join/add modes and phases)
import "./RelayShell.css";
import "./AddPcSheet.css";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

import { NEW_PC_MS, type MyPc } from "../lib/account/myPcs.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import type { RelayFailure, RelayShellState } from "../lib/relay/shellState.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { relayFailureText } from "./relayFailureText.ts";
import { EnrollmentStatus } from "./EnrollmentStatus.tsx";

export type AddPcSheetMode = "new" | "join" | "add";
export type AddPcPhase = "start" | "confirm" | "connecting" | "compare" | "wrong" | "approving" | "ready" | "failed";
export type AddPcStepStatus = "done" | "current" | "running" | "todo" | "failed";

export function addPcPhase(pc: MyPc, state: RelayShellState): AddPcPhase {
  switch (state.kind) {
    case "confirm": return state.offer.server_id === pc.server_id ? "confirm" : "start";
    case "connecting": return "connecting";
    case "compare": return state.wrong ? "wrong" : state.confirmed ? "approving" : "compare";
    case "ready": return state.server_id === pc.server_id ? "ready" : "start";
    case "failed": return "failed";
    default: return "start";
  }
}

function activeStepIndex(mode: "new" | "join", phase: AddPcPhase, failure: RelayFailure | null): number {
  if (phase === "ready") return 3;
  // the relay turns a new device away only once both people confirmed the digits: the steps before it went right
  if (phase === "approving" || (phase === "failed" && (failure === "pair-declined" || failure === "new-devices-refused"))) return 2;
  if (mode === "new" || phase === "compare" || phase === "wrong") return 1;
  return 0;
}

export function addPcSteps(mode: "new" | "join", phase: AddPcPhase, failure: RelayFailure | null): AddPcStepStatus[] {
  if (phase === "ready") return ["done", "done", "done", "done"];
  const at = activeStepIndex(mode, phase, failure);
  return [0, 1, 2, 3].map((step) => step < at ? "done" : step > at ? "todo" : phase === "failed" ? "failed" : mode === "join" && phase === "start" ? "current" : "running");
}

export interface AddPcSheetProps {
  mode: AddPcSheetMode; pc: MyPc | null; state: RelayShellState;
  onJoin: (pc: MyPc, options?: { typed?: boolean }) => void; onPair: () => void; onMatch: (typed?: string) => void;
  onRetry?: () => void; onOpenPc?: () => void; onCancel: () => void; onClose: () => void; onPairByQr: () => void;
}

export function AddPcSheet({ mode, pc, state, onJoin, onPair, onMatch, onRetry, onOpenPc, onCancel, onClose, onPairByQr }: AddPcSheetProps) {
  const t = useT(), locale = useLocale(), phone = useMediaQuery(SHEET_QUERY);
  const id = useId();
  const name = pc?.name ?? "";
  const phase = pc === null || mode === "add" ? null : addPcPhase(pc, state);
  const surface = useFocusTrap<HTMLDivElement>(true);
  const digitsInputRef = useRef<HTMLInputElement>(null);
  const challenge = state.kind === "compare" ? state.challenge ?? 0 : 0;
  const [submittedFor, setSubmittedFor] = useState<number | null>(null);
  const [retriedChallenge, setRetriedChallenge] = useState<number | null>(null);
  const prevChallenge = useRef<number | null>(null);

  if (state.kind === "compare" && state.wrong && challenge > 0 && retriedChallenge !== challenge) setRetriedChallenge(challenge);

  useLayoutEffect(() => {
    if (phase === "compare" && state.kind === "compare" && state.typed) {
      if (prevChallenge.current !== null && prevChallenge.current !== challenge && digitsInputRef.current) digitsInputRef.current.value = "";
      prevChallenge.current = challenge;
    }
  }, [phase, challenge, state.kind]);

  useLayoutEffect(() => { const node = surface.current; if (node !== null && !node.contains(document.activeElement)) node.focus({ preventScroll: true }); }, [phase]);

  const close = (): void => { if (phase !== null && phase !== "start" && phase !== "failed" && phase !== "ready") onCancel(); onClose(); };
  const latestClose = useRef(close);
  latestClose.current = close;
  useSheetSwipe(surface, close);
  usePhoneSheetBack(() => { latestClose.current(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      latestClose.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const windowExpired = mode === "join" || (pc?.added_at != null && Date.now() - Date.parse(pc.added_at) >= NEW_PC_MS);
  const pendingTyped = phase === "compare" && state.kind === "compare" && state.typed === true && submittedFor === challenge;

  const submitDigits = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pendingTyped) return;
    const field = event.currentTarget.elements.namedItem("digits") as HTMLInputElement | null;
    setSubmittedFor(challenge);
    onMatch((field?.value ?? "").replace(/\s/g, ""));
  };

  const cancel = <button key="cancel" type="button" className="btn" onClick={close}>{t("Cancel")}</button>, done = <button key="close" type="button" className="btn" onClick={close}>{t("Close")}</button>;
  const pairActions = (secondary: ReactNode, primary: ReactNode): ReactNode => phone ? <>{primary}{secondary}</> : <>{secondary}{primary}</>;
  let title: string, sub: string, body: ReactNode = null, actions: ReactNode;
  if (phase === null || pc === null) {
    title = t("Add a PC");
    sub = t("A PC joins through your account, or pairs with this device alone.");
    body = <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs to add it to your account, or pair with the QR code or pairing code it shows.")}</p>;
    actions = pairActions(<button key="close" type="button" className="btn" onClick={onClose}>{t("Close")}</button>, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={onPairByQr}>{t("Pair with a QR or code")}</button>);
  } else {
    title = mode === "new" ? t("Add {name} to your account", { name }) : t("Add this device to {name}", { name });
    sub = mode === "new"
      ? (windowExpired && phase !== "failed" ? t("Add window closed · an account member must approve.") : t("Type the number {name} shows on its own screen, then approve there.", { name }))
      // only a device connected to the PC hears its join request (docs/account.md "Who may admit a device"), so none is named
      : t("Add window closed · an account member must approve on a device connected to {name}.", { name });
    switch (phase) {
      case "start":
        actions = mode === "new"
          ? pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => onJoin(pc, { typed: true })}>{t("Add this PC")}</button>)
          : pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => onJoin(pc)}>{t("Ask to join")}</button>);
        break;
      case "confirm":
        body = <p className="relay-shell-copy">{t("Pair with {name}?", { name })}</p>;
        actions = pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={onPair}>{t("Pair")}</button>);
        break;
      case "connecting":
        body = <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{t("Connecting to {name}…", { name })}</p></div>;
        actions = cancel;
        break;
      case "compare": {
        const typed = state.kind === "compare" && state.typed === true;
        const digits = state.kind === "compare" ? state.digits : "";
        const freshAfterWrong = retriedChallenge !== null && challenge > retriedChallenge;
        if (typed) {
          body = (
            <form id={`${id}-digits-form`} className="relay-shell-code-form add-pc-typed" onSubmit={submitDigits}>
              <div className="field">
                <label className="field-label" htmlFor={`${id}-digits`}>{t("Number on {name}", { name })}</label>
                <input ref={digitsInputRef} id={`${id}-digits`} name="digits" className="input relay-shell-code-input" aria-label={t("Number on {name}", { name })} inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" disabled={pendingTyped} required autoFocus />
              </div>
              <p className="relay-shell-detail">{freshAfterWrong ? t("A new number is shown on {name} because the previous number changed.", { name }) : t("{name} shows six digits on its own screen now. Type them here, then approve on {name}.", { name })}</p>
            </form>
          );
          actions = pairActions(cancel, <button key="primary" type="submit" form={`${id}-digits-form`} className="btn btn-primary" data-sheet-primary disabled={pendingTyped} aria-busy={pendingTyped ? true : undefined}>{t("Add this PC")}</button>);
        } else {
          body = (
            <>
              <p className="relay-shell-digits" aria-label={digits.split("").join(" ")}>{`${digits.slice(0, 3)} ${digits.slice(3)}`}</p>
              <p className="relay-shell-copy">{t("A device connected to {name} shows three numbers: pick this one there.", { name })}</p>
            </>
          );
          actions = pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => onMatch()}>{t("The numbers match")}</button>);
        }
        break;
      }
      case "wrong":
        body = (
          <div role="alert">
            <p className="add-pc-problem">{t("That is not the number {name} shows", { name })}</p>
            <p className="relay-shell-copy">{t("Nothing was added. Try again to compare a new number, and type the one {name} shows.", { name })}</p>
          </div>
        );
        actions = onRetry ? pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary data-action="retry" onClick={onRetry}>{t("Try again")}</button>) : done;
        break;
      case "approving":
        body = (
          <div className="relay-shell-wait" role="status">
            <div className="boot-spinner" aria-hidden="true" />
            <p className="relay-shell-detail">{mode === "new" ? t("Approve this device on {name} within 90 seconds to finish.", { name }) : t("Waiting for an account member to approve this device within 90 seconds…")}</p>
          </div>
        );
        actions = cancel;
        break;
      case "ready":
        body = <><p className="relay-shell-copy" role="status">{t("{name} is ready to open on this device.", { name })}</p><EnrollmentStatus state={state.kind === "ready" ? state.enrollment : undefined} {...(onRetry ? { retry: onRetry } : {})} /></>;
        actions = pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => (onOpenPc ?? onClose)()}>{t("Open PC")}</button>);
        break;
      case "failed": {
        const failureKind = state.kind === "failed" ? state.failure : null;
        // a connection that failed says why even after the window closed: the window is not what stopped it
        // (so does the relay's refusal of a new device: the PC's account is past its limits, whatever the window)
        const connectionFailure = failureKind === "pc-offline" || failureKind === "pc-unresponsive" || failureKind === "relay-unreachable" || failureKind === "new-devices-refused";
        const expiredWindowFailure = mode === "new" && (failureKind === "pair-unavailable" || (windowExpired && !connectionFailure));
        const failure = state.kind === "failed" ? relayFailureText(t, state.failure, name, state.detail) : null;
        body = failure && (
          <div role="alert">
            <p className="add-pc-problem">{expiredWindowFailure ? t("Add window closed · an account member must approve") : failure.title}</p>
            <p className="relay-shell-copy">{expiredWindowFailure ? t("The 10-minute window on {name} has closed. Ask an account member to approve this device, or open {name} again.", { name }) : failure.copy}</p>
            {failure.detail !== null && <p className="relay-shell-detail"><code>{failure.detail}</code></p>}
          </div>
        );
        actions = failure?.retry && onRetry
          ? pairActions(done, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary data-action="retry" onClick={onRetry}>{t("Try again")}</button>)
          : done;
        break;
      }
    }
  }

  const failureKind = state.kind === "failed" ? state.failure : null;
  const stepNumber = phase === null || pc === null ? null : activeStepIndex(mode === "new" ? "new" : "join", phase, failureKind) + 1;
  const statuses = phase === null || pc === null ? [] : addPcSteps(mode === "new" ? "new" : "join", phase, failureKind);
  const steps = phase === null || pc === null ? null : (mode === "new" ? [
    [t("{name} signed in", { name }), t("It asked to join your account")],
    [t("Type the number {name} shows", { name }), t("Proves you are looking at that PC")],
    [t("Approve on {name}", { name }), t("The PC decides who gets in, not the account")],
    [t("Ready"), t("This device can open {name}", { name })],
  ] : [
    [t("Ask to join"), t("Through your account, with this device's key")],
    [t("Check the number on a device connected to {name}", { name }), t("It shows three; pick the one this device shows")],
    [t("Approved by an account member"), t("On that device, never on {name} itself", { name })],
    [t("Ready"), t("This device can open {name}", { name })],
  ]).map(([label, detail], step) => ({ label, detail, status: statuses[step] ?? "todo" }));

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={surface} className="modal add-pc-sheet" lang={locale} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-sub`} tabIndex={-1} data-add-pc-mode={mode} {...(phase === null ? {} : { "data-add-pc-phase": phase })}>
        <header className="modal-header add-pc-head">
          {steps && <div className="add-pc-bars" aria-hidden="true">{steps.map(({ status }, step) => <span key={step} data-bar={status} />)}</div>}
          {stepNumber !== null && <p className="add-pc-step-count">{t("Step {n} of {total}", { n: stepNumber, total: 4 })}</p>}
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <p className="add-pc-sub" id={`${id}-sub`}>{sub}</p>
        </header>
        <div className="modal-body add-pc-body">
          {body}
          {steps && (
            <ol className="add-pc-steps">
              {steps.map(({ label, detail, status }, step) => (
                <li key={step} data-step={status} {...(status === "running" || status === "current" ? { "aria-current": "step" } : {})}>
                  <span className="add-pc-mark" aria-hidden="true">{status === "done" ? <Check /> : status === "failed" ? <X /> : null}</span>
                  <span className="add-pc-step-text">
                    <span className="add-pc-step-label">{label}</span>
                    <span className="add-pc-step-detail">{detail}</span>
                  </span>
                  {status === "done" && <span className="visually-hidden">{t("Done")}</span>}
                  {status === "failed" && <span className="visually-hidden">{t("Failed")}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
        {actions !== null && <footer className="modal-footer add-pc-footer">{actions}</footer>}
      </div>
    </div>,
    document.body,
  );
}
