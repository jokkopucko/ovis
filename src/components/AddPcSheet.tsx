// allow: SIZE_OK — cohesive 4-step modal sheet state machine (new/join modes and phases)
import "./RelayShell.css";
import "./AddPcSheet.css";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

import type { MyPc } from "../lib/account/myPcs.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import type { RelayFailure, RelayShellState } from "../lib/relay/shellState.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { approveOnLine } from "./approveOnLine.ts";
import { relayFailureText } from "./relayFailureText.ts";
import { EnrollmentStatus } from "./EnrollmentStatus.tsx";
import { JoinWait } from "./JoinWait.tsx";
import { KeyFingerprintWait } from "./PendingKeys.tsx";

export type AddPcSheetMode = "new" | "join";
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
  if (phase === "approving" || (phase === "failed" && (failure === "pair-declined" || failure === "pair-unanswered" || failure === "new-devices-refused"))) return 2;
  if (mode === "new" || phase === "compare" || phase === "wrong") return 1;
  return 0;
}

export function addPcSteps(mode: "new" | "join", phase: AddPcPhase, failure: RelayFailure | null): AddPcStepStatus[] {
  if (phase === "ready") return ["done", "done", "done", "done"];
  const at = activeStepIndex(mode, phase, failure);
  return [0, 1, 2, 3].map((step) => step < at ? "done" : step > at ? "todo" : phase === "failed" ? "failed" : mode === "join" && phase === "start" ? "current" : "running");
}

export interface AddPcSheetProps {
  mode: AddPcSheetMode; pc: MyPc; state: RelayShellState;
  onJoin: (pc: MyPc, options?: { typed?: boolean }) => void; onPair: () => void; onMatch: (typed?: string) => void;
  onRetry?: () => void; onOpenPc?: () => void; onCancel: () => void; onClose: () => void;
  /**
   * A new PC's second way: the directory cannot tell a PC whose screen waits to be added from one already put in the
   * account by a QR code before its first mailbox pull, so the start offers the join sheet beside the typed number, and
   * a typed comparison whose PC shows no number turns into a join (this device then shows its digits).
   */
  onAskToJoin?: () => void;
}

const APPROVE_COMMAND = "ovis pair --approve";

/** A sentence with a command in it, the command kept on one line as code. */
function withCommand(sentence: string, command: string): ReactNode {
  const at = sentence.indexOf(command);
  if (at < 0) return sentence;
  return <>{sentence.slice(0, at)}<code className="add-pc-command">{command}</code>{sentence.slice(at + command.length)}</>;
}

export function AddPcSheet({ mode, pc, state, onJoin, onPair, onMatch, onRetry, onOpenPc, onCancel, onClose, onAskToJoin }: AddPcSheetProps) {
  const t = useT(), locale = useLocale(), phone = useMediaQuery(SHEET_QUERY);
  const id = useId();
  const name = pc.name;
  const phase = addPcPhase(pc, state);
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

  useLayoutEffect(() => { const node = surface.current; if (node !== null && !node.contains(document.activeElement)) node.focus({ preventScroll: true }); }, [phase, mode]);

  const close = (): void => { if (phase !== "start" && phase !== "failed" && phase !== "ready") onCancel(); onClose(); };
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
  // a new device's way in: approval on a device it already uses
  const joinStart = mode !== "new" && phase === "start";
  title = mode === "new" ? t("Add {name} to your account", { name }) : joinStart ? t("Get approved on a device you already use") : t("Add this device to {name}", { name });
  // the request reaches only a device with this PC open in Ovis (server/dispatch.ts remote-pairings): the line says so
  sub = joinStart ? t("Open {name} in Ovis on a device you already use and approve there, or on {name} itself: Settings → Devices and PCs, then type the number this device shows.", { name }) : mode === "new"
    ? phase === "start" && onAskToJoin
      ? t("Type the number {name} shows on its own screen after you start Add, then approve there. If {name} is already in your account, ask to join instead.", { name })
      : t("Type the number {name} shows on its own screen, then approve there.", { name })
    // a device connected to the PC hears its join request (docs/account.md "Who may admit a device"), or the PC itself
    // while its own Add screen waits; an instruction, not a claim: the directory cannot say which, so both are named
    : t("Approve this device on a device of your account connected to {name}, or on {name} itself: Settings → Devices and PCs, then type the number this device shows.", { name });
  switch (phase) {
    case "start":
      if (mode === "new" && onAskToJoin) {
        const ask = <button key="ask" type="button" className="btn" data-action="ask-to-join" onClick={onAskToJoin}>{t("Ask to join")}</button>;
        actions = pairActions(phone ? [ask, cancel] : [cancel, ask], <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => onJoin(pc, { typed: true })}>{t("Add this PC")}</button>);
        break;
      }
      actions = mode === "new"
        ? pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => onJoin(pc, { typed: true })}>{t("Add this PC")}</button>)
        : pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => onJoin(pc)}>{t("Ask to join")}</button>);
      break;
    case "confirm":
      body = <p className="relay-shell-copy">{t("Pair with {name}?", { name })}</p>;
      actions = pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={onPair}>{t("Pair")}</button>);
      break;
    case "connecting":
      body = state.kind === "connecting" && state.hold !== undefined ? <JoinWait pc={name} hold={state.hold} />
        : state.kind === "connecting" && state.keyFingerprint !== undefined ? <KeyFingerprintWait pc={name} fingerprint={state.keyFingerprint} />
        : <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{t("Connecting to {name}…", { name })}</p></div>;
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
            {onAskToJoin && <p className="relay-shell-detail">{t("{name} shows no number? Ask to join instead.", { name })}</p>}
          </form>
        );
        // a PC not waiting on its own screen shows no number: the same request goes on as a join, with this device's digits
        const ask = onAskToJoin && <button key="ask" type="button" className="btn" data-action="ask-to-join" onClick={onAskToJoin}>{t("Ask to join")}</button>;
        actions = pairActions(ask ? (phone ? [ask, cancel] : [cancel, ask]) : cancel, <button key="primary" type="submit" form={`${id}-digits-form`} className="btn btn-primary" data-sheet-primary disabled={pendingTyped} aria-busy={pendingTyped ? true : undefined}>{t("Add this PC")}</button>);
      } else {
        body = (
          <>
            <p className="relay-shell-digits" aria-label={digits.split("").join(" ")}>{`${digits.slice(0, 3)} ${digits.slice(3)}`}</p>
            <p className="relay-shell-copy">{t("Check that this number matches where you approve, then approve.")}</p>
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
      // a first join: the PC compares this number beside its Allow, so it stays on screen with the one line
      if (state.kind === "compare" && state.approveOn !== undefined) {
        body = (
          <div role="status">
            <p className="relay-shell-digits" aria-label={state.digits.split("").join(" ")}>{`${state.digits.slice(0, 3)} ${state.digits.slice(3)}`}</p>
            <p className="relay-shell-copy">{approveOnLine(t, state.approveOn)}</p>
          </div>
        );
        actions = cancel;
        break;
      }
      body = (
        <div className="relay-shell-wait" role="status">
          <div className="boot-spinner" aria-hidden="true" />
          <p className="relay-shell-detail">{mode === "new" ? t("Approve this device on {name} within 90 seconds to finish.", { name }) : t("Waiting up to 90 seconds for approval…")}</p>
        </div>
      );
      actions = cancel;
      break;
    case "ready":
      body = <><p className="relay-shell-copy" role="status">{t("{name} is ready to open on this device.", { name })}</p><EnrollmentStatus state={state.kind === "ready" ? state.enrollment : undefined} {...(onRetry ? { retry: onRetry } : {})} /></>;
      actions = pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => (onOpenPc ?? onClose)()}>{t("Open PC")}</button>);
      break;
    case "failed": {
      const failure = state.kind === "failed" ? relayFailureText(t, state.failure, name, state.detail, mode === "new" ? "new" : "join") : null;
      body = failure && (
        <div role="alert">
          <p className="add-pc-problem">{failure.title}</p>
          <p className="relay-shell-copy">{failure.copy}</p>
          {failure.detail !== null && <p className="relay-shell-detail"><code>{failure.detail}</code></p>}
        </div>
      );
      actions = failure?.retry && onRetry
        ? pairActions(done, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary data-action="retry" onClick={onRetry}>{t("Try again")}</button>)
        : done;
      break;
    }
  }

  // a join a PC's own page offers: one press to ask, then the number alone, which the PC checks and approves
  if ((state.kind === "confirm" || state.kind === "compare") && state.alone === true) {
    const asking = state.kind === "confirm";
    // a join into the account's list: a member signs this device in on its person's word, which only this press gives
    const pressing = state.kind === "compare" && !state.confirmed;
    return createPortal(
      <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div ref={surface} className="modal add-pc-sheet add-pc-alone" lang={locale} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} data-add-pc-mode={mode} data-add-pc-phase={asking ? "confirm" : "compare"}>
          <header className="modal-header add-pc-head"><h2 className="modal-title" id={`${id}-title`}>{asking ? t("Add this device to {name}", { name }) : t("Approve it on {name}", { name })}</h2></header>
          {state.kind === "compare" && (
            <div className="modal-body add-pc-body">
              <p className="relay-shell-digits" aria-label={state.digits.split("").join(" ")}>{`${state.digits.slice(0, 3)} ${state.digits.slice(3)}`}</p>
              <p className="relay-shell-copy">{pressing ? t("Check that this number matches where you approve, then approve.") : state.approveOn === undefined ? t("Approve it if the PC shows the same number.") : approveOnLine(t, state.approveOn)}</p>
            </div>
          )}
          <footer className="modal-footer add-pc-footer">{asking ? pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={onPair}>{t("Ask to join")}</button>)
            : pressing ? pairActions(cancel, <button key="primary" type="button" className="btn btn-primary" data-sheet-primary onClick={() => onMatch()}>{t("The numbers match")}</button>) : cancel}</footer>
          {/* a first join is the PC's alone to approve: no other way to point at */}
          {state.kind === "compare" && state.approveOn === undefined && (
            <details className="add-pc-other">
              <summary>{t("Another way")}</summary>
              <p className="relay-shell-detail">{withCommand(t("In the PC's terminal: ovis pair --approve"), APPROVE_COMMAND)}</p>
              <p className="relay-shell-detail">{t("Or approve it on another device of your account that has this PC open.")}</p>
            </details>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  const failureKind = state.kind === "failed" ? state.failure : null;
  // a first join waits on the PC alone: the number and its one line, no steps or subtitle about who else approves
  const waitsOnPc = phase === "approving" && state.kind === "compare" && state.approveOn !== undefined;
  const stepNumber = activeStepIndex(mode, phase, failureKind) + 1;
  const statuses = addPcSteps(mode, phase, failureKind);
  const steps = waitsOnPc ? null : (mode === "new" ? [
    [t("{name} signed in", { name }), t("It asked to join your account")],
    [t("Type the number {name} shows", { name }), t("Proves you are looking at that PC")],
    [t("Approve on {name}", { name }), t("The PC decides who gets in, not the account")],
    [t("Ready"), t("This device can open {name}", { name })],
  ] : [
    [t("Ask to join"), t("Through your account, with this device's key")],
    [t("Check the number on a device connected to {name}", { name }), t("It shows three; pick the one this device shows")],
    [t("Approved by an account member"), t("On a device of your account that is connected to {name}, or on {name} itself", { name })],
    [t("Ready"), t("This device can open {name}", { name })],
  ]).map(([label, detail], step) => ({ label, detail, status: statuses[step] ?? "todo" }));

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={surface} className="modal add-pc-sheet" lang={locale} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} {...(waitsOnPc ? {} : { "aria-describedby": `${id}-sub` })} tabIndex={-1} data-add-pc-mode={mode} data-add-pc-phase={phase}>
        <header className="modal-header add-pc-head">
          {/* the thin bars alone say where it stands; the step's number is the bars' own, for a screen reader */}
          {steps && <div className="add-pc-bars" role="progressbar" aria-label={title} aria-valuemin={1} aria-valuemax={4} aria-valuenow={stepNumber} aria-valuetext={t("Step {n} of {total}", { n: stepNumber, total: 4 })}>{steps.map(({ status }, step) => <span key={step} data-bar={status} />)}</div>}
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          {!waitsOnPc && <p className="add-pc-sub" id={`${id}-sub`}>{sub}</p>}
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
