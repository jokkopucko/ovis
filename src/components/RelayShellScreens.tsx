import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, Monitor } from "lucide-react";

import { STORE_PAGES } from "../lib/appShell.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { useSettings } from "../lib/settings.ts";
import type { KeyMismatch } from "../lib/relay/shellState.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { describeUpdate } from "../lib/updateProgress.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { AccountSignIn, CheckPcsButton, PcStatusLine } from "./AccountPcs.tsx";
import { JoinWait } from "./JoinWait.tsx";
import { KeyId } from "./KeyId.tsx";
import { KeyFingerprintWait } from "./PendingKeys.tsx";
import { approveOnLine } from "./approveOnLine.ts";
import { relayFailureText } from "./relayFailureText.ts";
import { CodeEntry, ReadyCheckpoint, type RelayShellProps } from "./RelayShell.tsx";
import { canScanQr } from "./RelayAddPc.tsx";
import { SheepMascot } from "./SheepMascot.tsx";

/** Why the plain screen is up (#16): what the person does next on the PC, or why nothing goes on. */
export type PlainReason = "allow" | "type" | "off" | "declined" | "refused" | "unanswered" | "removed";

/**
 * #16: the one plain screen a signed-in device waits on while the join a launch asked by itself goes on, or after this
 * device was removed from a PC, app and browser alike: the PC's name, one line with what to do there (press Allow, type
 * this number, turn Ovis on, ask again after a decline, a refusal or a removal), the number when the join shows one, and under it
 * the PC screen's QR way in (a code in a browser). No tabs, no banner, no list.
 */
export function PcApprovalWait({ reason, name, digits = null, onQr, onCheck, onAskAgain }: {
  readonly reason: PlainReason; readonly name: string | null; readonly digits?: string | null;
  readonly onQr: () => void; readonly onCheck?: (() => void) | undefined; readonly onAskAgain?: (() => void) | undefined;
}) {
  const t = useT();
  const line = (() => {
    switch (reason) {
      case "allow": return t("Press [Allow] on {name}", { name: name ?? t("this PC") });
      case "type": return t("Type this number on {name}", { name: name ?? t("this PC") });
      case "off": return name === null ? t("Turn on Ovis on the PC") : t("{name} is off. Turn on Ovis on it.", { name });
      case "declined": return t("Not allowed. Ask again, then press [Allow] on {name}.", { name: name ?? t("this PC") });
      // the PC turned the request down before anybody was asked (in no account yet, paused after too many tries): nobody declined it
      case "refused": return t("{name} cannot take this device yet", { name: name ?? t("this PC") });
      case "unanswered": return t("No answer from {name}", { name: name ?? t("this PC") });
      case "removed": return t("This device was removed from {name}. Ask again to join it.", { name: name ?? t("this PC") });
      default: {
        const exhaustive: never = reason;
        return exhaustive;
      }
    }
  })();
  const waiting = reason === "allow" || reason === "type";
  const problem = reason === "declined" || reason === "refused" || reason === "unanswered" || reason === "removed";
  return (
    <div className="relay-shell account-centered relay-approval-wait" data-approval-wait={name === null && reason === "off" ? "no-pc" : reason === "allow" || reason === "type" ? "pc" : reason}>
      {name !== null && <h1 className="relay-shell-title">{name}</h1>}
      <p className={problem ? "relay-shell-copy add-pc-problem" : "relay-shell-copy"} role={problem ? "alert" : "status"}>{line}</p>
      {digits !== null && digits !== "" && <p className="relay-shell-digits" aria-label={digits.split("").join(" ")}>{`${digits.slice(0, 3)} ${digits.slice(3)}`}</p>}
      {waiting && <div className="relay-shell-wait"><div className="boot-spinner" aria-hidden="true" /></div>}
      {onAskAgain && <button type="button" className="btn btn-primary" data-action="ask-again" onClick={onAskAgain}>{t("Ask again")}</button>}
      {onCheck && <button type="button" className="btn" data-action="check-again" onClick={onCheck}>{t("Check again")}</button>}
      <button type="button" className="btn btn-ghost account-link" data-action="approval-wait-qr" onClick={onQr}>{canScanQr() ? t("Or scan the QR on the PC's screen") : t("Or pair with a code")}</button>
    </div>
  );
}

function PcCard({ name, detail = null }: { readonly name: string; readonly detail?: string | null }) {
  return (
    <div className="relay-step-cards">
      <div className="relay-step-card">
        <span className="relay-step-card-icon"><Monitor aria-hidden="true" /></span>
        <span className="relay-step-card-text"><span className="relay-step-card-name">{name}</span>{detail !== null && <span className="relay-step-card-detail">{detail}</span>}</span>
      </div>
    </div>
  );
}

export interface TypedDigitsProps {
  readonly pc: string;
  readonly onSubmit: (digits: string) => void;
  readonly cancel?: ReactNode;
  readonly challenge?: number | undefined;
  readonly compact?: boolean | undefined;
  readonly formId?: string | undefined;
}

/**
 * Adding a PC listed in the account: the six digits come from that PC's own screen, typed here, so a
 * PC someone else listed under a familiar name cannot be added with a tap. Kept in the input itself.
 */
export function TypedDigits({ pc, onSubmit, cancel, challenge, compact = false, formId }: TypedDigitsProps) {
  const t = useT();
  const id = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const lastChallenge = useRef(challenge);
  useEffect(() => {
    if (challenge !== undefined && lastChallenge.current !== undefined && challenge !== lastChallenge.current && fieldRef.current) fieldRef.current.value = "";
    lastChallenge.current = challenge;
  }, [challenge]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit((event.currentTarget.elements.namedItem("digits") as HTMLInputElement).value.replace(/\s/g, ""));
  };
  const label = t("Number on {name}", { name: pc });
  return (
    <>
      {!compact && <h1 className="relay-shell-title">{t("Type the number {name} shows", { name: pc })}</h1>}
      {!compact && <p className="relay-shell-copy">{t("{name} shows six digits on its own screen now. Type them here, then approve on {name}.", { name: pc })}</p>}
      <p className="relay-shell-detail">{t("No number on {name}? Cancel, then tap {name} in your list.", { name: pc })}</p>
      <form id={formId} className="relay-shell-code-form" onSubmit={submit}>
        <label className="relay-shell-field-label" htmlFor={`${id}-digits`}>{label}</label>
        <input ref={fieldRef} id={`${id}-digits`} name="digits" className="input relay-shell-code-input" aria-label={label} placeholder="000 000" inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" required autoFocus />
        {cancel !== undefined && <div className="relay-shell-actions"><button type="submit" className="btn btn-primary">{t("Add this PC")}</button>{cancel}</div>}
      </form>
    </>
  );
}

/**
 * The id named and the id of the key that is not it, groups that differ marked, each labelled by
 * where it came from.
 */
export function KeyIds({ mismatch, named }: { readonly mismatch: KeyMismatch; readonly named: "link" | "paired" }) {
  const t = useT();
  const expected = named === "link" ? t("ID this link names") : t("ID this phone paired with");
  const received = mismatch.from === "link" ? t("ID of the key this link carries") : t("ID of the key this phone saved");
  return (
    <>
      <dl className="relay-shell-keys">
        <dt>{expected}</dt>
        <dd><KeyId id={mismatch.expected} label={expected} /></dd>
        <dt>{received}</dt>
        <dd>{mismatch.received === null ? <span className="relay-shell-copy">{t("Not a valid key")}</span> : <KeyId id={mismatch.received} against={mismatch.expected} label={received} />}</dd>
      </dl>
      <p className="relay-shell-detail">{t("Only the PC itself shows its ID, at the top of Settings → Devices and PCs. Marked groups differ.")}</p>
    </>
  );
}

export const INSTALLER_COMMAND = "curl -fsSL https://ovis.sh/install.sh | sh";
export const PLUGIN_COMMANDS = "herdr plugin install devswha/ovis\nherdr plugin action invoke devswha.ovis.stop\nherdr plugin action invoke devswha.ovis.start";

function CopyableCommand({ command }: { readonly command: string }) {
  const t = useT();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void copyText(command, preRef.current).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="relay-shell-command-row">
      <pre ref={preRef} className="relay-shell-command"><code>{command}</code></pre>
      <button type="button" className="btn relay-shell-copy-btn" onClick={copy}>{t(copied ? "Copied" : "Copy")}</button>
    </div>
  );
}

export interface RelayShellCardContentProps {
  readonly props: RelayShellProps;
  /** a saved PC's failure: the button that opens it by another way the phone app saved it by */
  readonly other?: ReactNode;
}

/** What continuing agrees to: Ovis's privacy policy (ovis.sh/privacy, in English and Korean), linked. */
function AgreementLine() {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const privacy = resolvedLanguage === "ko" ? "https://ovis.sh/ko/privacy/" : "https://ovis.sh/privacy/";
  const [before = "", after = ""] = t("By continuing, you agree to the {privacy}.").split("{privacy}");
  return <p className="relay-shell-agreement">{before}<ExternalLink kind="ovis" href={privacy}>{t("Privacy Policy")}</ExternalLink>{after}</p>;
}

/**
 * While the sign-in is read nothing is claimed and the button is held; while a press is checked, the wording it was
 * made on stays up (`pressed`), so the question does not change under it.
 */
function PairConfirm({ state, pc, onPair }: { state: Extract<RelayShellProps["state"], { kind: "confirm" }>; pc: string; onPair: () => void }) {
  const t = useT();
  const checking = state.account === "checking";
  const said = checking ? state.pressed : state.account ?? "own";
  return (
    <>
      <SheepMascot screen="header" size={56} badge />
      <h1 className="relay-shell-title">{said === "unlisted" ? t("Add {name} to your account?", { name: pc }) : t("Pair with {name}?", { name: pc })}</h1>
      {said === "unlisted" && <p className="relay-shell-copy">{t("Pairing adds this PC to your Ovis account, so every device of your account can open it. Pair only with a PC you are setting up yourself.")}</p>}
      {said === "listed" && <p className="relay-shell-copy">{t("This device joins {name} with your account's key. The PC lists it under Settings → Devices and PCs, where it can be removed.", { name: pc })}</p>}
      {said === "own" && <p className="relay-shell-copy">{t("This device gets a key of its own for {name}. The PC lists it under Settings → Devices and PCs, where it can be removed.", { name: pc })}</p>}
      <PcCard name={pc} detail={said === "unlisted" ? t("Your Ovis account") : null} />
      {/* the PC's ID is there for whoever wants to compare it, not in the way; the frame's Back says Not now */}
      {said === "unlisted" && (
        <details className="relay-step-details">
          <summary>{t("Details")}</summary>
          <p className="relay-shell-code-id"><KeyId id={state.offer.server_id} label={t("ID of the PC this link names")} /></p>
        </details>
      )}
      {/* a device whose confirm spoke of no account is told of none */}
      {checking && said !== "own" && <p className="relay-shell-detail" role="status">{t("Checking your account…")}</p>}
      <div className="relay-shell-actions">
        <button type="button" className="btn btn-primary" disabled={checking} aria-busy={checking || undefined} onClick={onPair}>{said === "unlisted" ? t("Add and pair") : t("Pair")}</button>
      </div>
    </>
  );
}

/**
 * What the card says on every screen but the front page (RelayShell draws My PCs and Add a PC itself): a pairing's steps,
 * a code typed in, a failure, an update, and the list of this device's pairings on a relay with no accounts.
 */
export function RelayShellCardContent({ props, other = null }: RelayShellCardContentProps) {
  const { state, pcStatus, onCheckPcs, scoped, iosTab, onPair, onRetry, onCancel, onBack, onForget, onUpdate, onMatch, onCodeStart, onCodeSubmit, onCodeMatch, onOpenPc, onSignIn, accountProviders } = props;
  const t = useT();
  const account = (state.kind === "list" || state.kind === "empty") && onSignIn ? state.account ?? null : null;
  const name = state.kind === "confirm" || state.kind === "code-compare" ? state.offer.name ?? null
    : state.kind === "list" || state.kind === "empty" || state.kind === "code-entry" || state.kind === "code-looking" ? null : state.name;
  const pc = name ?? t("this PC");
  const back = scoped ? <button type="button" className="btn btn-ghost" onClick={onBack}>{t("Back")}</button> : null;
  const progress = state.kind === "outdated" && state.update.phase === "installing" ? describeUpdate({ phase: "building", step: state.update.step }) : null;
  const retry = <button type="button" className="btn btn-primary" onClick={onRetry}>{t("Try again")}</button>;
  const failure = state.kind === "failed" ? relayFailureText(t, state.failure, pc, state.detail) : null;
  // a marked pairing that stopped for a sign-in signs in right here, and goes on after it without a new scan
  const pairSignIn = state.kind === "failed" && state.failure === "sign-in-first" && onSignIn ? state.account ?? null : undefined;
  const statusText = state.kind === "code-looking" ? t("Looking for the PC…") : state.kind === "connecting" ? (state.approved ? t("Approved. {name} opens in a moment.", { name: pc }) : t("Connecting to {name}…", { name: pc }))
    : state.kind === "compare" && state.confirmed ? t("Approve this device on {name} within 90 seconds to finish.", { name: pc })
    : state.kind === "outdated" && state.update.phase === "reading" ? t("Checking {name}…", { name: pc })
    : state.kind === "outdated" && state.update.phase === "installing" ? (progress ? `${progress.step}: ${t(progress.label)}` : t("Asking the PC to update…"))
    : state.kind === "outdated" && state.update.phase === "restarting" ? t("Waiting for {name} to restart…", { name: pc }) : null;
  // the press removes the button that had the focus: the heading of what follows takes it, so a keyboard keeps its place
  const pressedTitle = useRef<HTMLHeadingElement>(null);
  const pressed = state.kind === "compare" && state.confirmed;
  useEffect(() => {
    if (pressed && (document.activeElement === null || document.activeElement === document.body)) pressedTitle.current?.focus();
  }, [pressed]);
  const announcedStatus = useAnnouncedText(statusText);

  return (
    <>
      <div className="visually-hidden" role="status">{announcedStatus}</div>
      {state.kind === "ready" && onOpenPc && <ReadyCheckpoint open={onOpenPc} cancel={onCancel} state={state} retry={onRetry} />}
      {state.kind === "list" && account === null && (
        <>
          <h1 className="relay-shell-title">{t("Your PCs")}</h1>
          {onCheckPcs && <CheckPcsButton status={pcStatus ?? new Map()} onCheck={onCheckPcs} />}
          <ul className="relay-shell-pcs">
            {state.devices.map((device) => {
              const status = pcStatus?.get(device.server_id);
              return (
                <li key={device.server_id}>
                  <a className="relay-shell-pc" href={serverScopePath(device.server_id)}>
                    <span className="account-pc-text">
                      <span className="relay-shell-pc-name">{device.name ?? t("Unnamed PC")}</span>
                      {status && <PcStatusLine status={status} />}
                    </span>
                    <ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" />
                  </a>
                </li>
              );
            })}
          </ul>
          <p className="relay-shell-copy">{t("To add another PC, open Settings → Devices and PCs → Add a connection → Ovis relay on it and scan the QR code.")}</p>
          <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCodeStart}>{t("Pair with a code")}</button></div>
        </>
      )}
      {(state.kind === "code-entry" || state.kind === "code-looking") && (
        <CodeEntry failure={state.kind === "code-entry" ? state.failure : null} looking={state.kind === "code-looking"} onSubmit={onCodeSubmit} back={<button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>} />
      )}
      {state.kind === "code-compare" && (
        <>
          <h1 className="relay-shell-title">{t("Does {name}'s screen show this ID?", { name: pc })}</h1>
          <p className="relay-shell-copy">{t("The PC shows its ID under the code. Pair only if every group matches. On older versions, check Settings → Devices and PCs → Connected to this PC, or go back and use a code from Settings → Agents → Setup guide → Other ways → Show a code to type.")}</p>
          <p className="relay-shell-code-id"><KeyId id={state.offer.server_id} label={t("ID of the PC this code found")} /></p>
          <div className="relay-shell-actions"><button type="button" className="btn btn-primary" onClick={onCodeMatch}>{t("It matches")}</button><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
        </>
      )}
      {state.kind === "confirm" && <PairConfirm state={state} pc={pc} onPair={onPair} />}
      {/* the frame's Back cancels a connecting pairing */}
      {state.kind === "connecting" && state.pairing && (
        <>
          <SheepMascot screen="connecting" size={56} badge />
          <h1 className="relay-shell-title">{t("Connecting to {name}…", { name: pc })}</h1>
          {state.approved && <p className="relay-shell-copy">{t("Approved. {name} opens in a moment.", { name: pc })}</p>}
          {state.keyFingerprint === undefined ? <PcCard name={pc} /> : <KeyFingerprintWait pc={pc} fingerprint={state.keyFingerprint} />}
        </>
      )}
      {state.kind === "connecting" && !state.pairing && (
        <>
          <h1 className="relay-shell-title">{t("Connecting to {name}…", { name: pc })}</h1>
          {state.hold === undefined ? <div className="relay-shell-wait"><div className="boot-spinner" aria-hidden="true" /></div> : <JoinWait pc={pc} hold={state.hold} />}
          <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
        </>
      )}
      {state.kind === "compare" && state.typed && !state.confirmed && (
        state.wrong ? (
          <>
            <h1 className="relay-shell-title">{t("That is not the number {name} shows", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("Nothing was added. Tap the PC again to compare a new number, and type the one its own screen shows.")}</p>
            <div className="relay-shell-actions">{retry}<button type="button" className="btn" onClick={onCancel}>{t("Back")}</button></div>
          </>
        ) : <TypedDigits pc={pc} challenge={state.challenge} onSubmit={onMatch} cancel={<button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>} />
      )}
      {/* until this phone says the numbers match the pairing waits on its press; after it, only on the PC's approval */}
      {state.kind === "compare" && !(state.typed && !state.confirmed) && (
        <>
          <SheepMascot screen="waiting" size={56} badge />
          <h1 className="relay-shell-title" ref={pressedTitle} tabIndex={-1}>{state.approveOn !== undefined ? approveOnLine(t, state.approveOn) : state.confirmed ? t("Approve on the PC if it shows the same number") : t("Does {name} show this number?", { name: pc })}</h1>
          {!state.confirmed && <p className="relay-shell-copy">{t("If they match, approve this device on {name}.", { name: pc })}</p>}
          <div className="relay-step-cards">
            <div className="relay-step-card relay-step-number">
              {/* a typed comparison's digits are only on the PC's screen: the card keeps the 90 seconds line alone */}
              {!state.typed && <p className="relay-shell-digits" aria-label={state.digits.split("").join(" ")}>{`${state.digits.slice(0, 3)} ${state.digits.slice(3)}`}</p>}
              {state.confirmed && state.approveOn === undefined && <p className="relay-shell-detail">{t("Approve this device on {name} within 90 seconds to finish.", { name: pc })}</p>}
            </div>
          </div>
          <div className="relay-shell-actions">{!state.confirmed && <button type="button" className="btn btn-primary" onClick={() => onMatch()}>{t("The numbers match")}</button>}<button type="button" className="btn relay-step-quiet" onClick={onCancel}>{t("Cancel")}</button></div>
        </>
      )}
      {state.kind === "failed" && failure !== null && pairSignIn !== undefined && onSignIn && (
        <div className="relay-shell-pair-signin">
          <h1 className="relay-shell-hero"><span>{t("Your PCs, anywhere.")}</span>{" "}<span className="relay-shell-hero-quiet">{t("Sign in to your Ovis account")}</span></h1>
          <AccountSignIn nameOnly onSignIn={onSignIn} error={pairSignIn?.kind === "signed-out" ? pairSignIn.error : null} busy={pairSignIn?.kind === "signing-in"}
            busyProvider={pairSignIn?.kind === "signing-in" ? (pairSignIn.provider ?? null) : null} failedProvider={pairSignIn?.kind === "signed-out" ? (pairSignIn.provider ?? null) : null}
            {...(accountProviders ? { providers: accountProviders } : {})} />
          <AgreementLine />
          {failure.detail !== null && <p className="relay-shell-detail"><code>{failure.detail}</code></p>}
          {back && <div className="relay-shell-actions relay-shell-quiet">{back}</div>}
        </div>
      )}
      {state.kind === "failed" && failure !== null && pairSignIn === undefined && (
        <>
          {state.pairing && <SheepMascot screen="refused" size={56} badge />}
          <h1 className="relay-shell-title">{failure.title}</h1>
          <p className="relay-shell-copy">{failure.copy}</p>
          {failure.detail !== null && <p className="relay-shell-detail"><code>{failure.detail}</code></p>}
          {state.failure === "identity-changed" ? (
            <>
              {state.mismatch && <KeyIds mismatch={state.mismatch} named="paired" />}
              <div className="relay-shell-actions"><button type="button" className="btn btn-danger" onClick={onForget}>{t("Forget this PC")}</button>{back}</div>
            </>
          ) : (failure.retry || back || other) && <div className="relay-shell-actions">{failure.retry && retry}{other}{back}</div>}
        </>
      )}
      {state.kind === "outdated" && (
        <>
          <h1 className="relay-shell-title">{t("Update Ovis on {name}", { name: pc })}</h1>
          <p className="relay-shell-copy">{t("{name} runs Ovis {version}; this app needs {min} or newer.", { name: pc, version: state.serverVersion, min: state.minVersion })}</p>
          {state.update.phase === "reading" && <div className="relay-shell-wait"><div className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{t("Checking {name}…", { name: pc })}</p></div>}
          {state.update.phase === "offer" && <><p className="relay-shell-copy relay-shell-more">{t("Update it from here: the PC installs the latest release and restarts Ovis, then this app reconnects.")}</p><div className="relay-shell-actions"><button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>{back}</div></>}
          {state.update.phase === "manual" && <><p className="relay-shell-copy relay-shell-more">{t("Its Ovis does not update itself. On the PC, run the installer:")}</p><CopyableCommand command={INSTALLER_COMMAND} /><p className="relay-shell-copy relay-shell-more">{t("Or, for the herdr plugin, reinstall it and restart Ovis:")}</p><CopyableCommand command={PLUGIN_COMMANDS} /><div className="relay-shell-actions">{retry}{back}</div></>}
          {state.update.phase === "installing" && <div className="relay-shell-wait"><div className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{progress ? `${progress.step}: ${t(progress.label)}` : t("Asking the PC to update…")}</p></div>}
          {state.update.phase === "restarting" && <div className="relay-shell-wait"><div className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{t("Waiting for {name} to restart…", { name: pc })}</p></div>}
          {state.update.phase === "failed" && <><p className="relay-shell-copy relay-shell-more">{t("The update did not finish.")}</p>{state.update.detail !== null && <p className="relay-shell-detail"><code>{state.update.detail}</code></p>}<div className="relay-shell-actions"><button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>{back}</div></>}
        </>
      )}
      {state.kind === "app-outdated" && (
        <>
          <h1 className="relay-shell-title">{t("Update the app")}</h1>
          <p className="relay-shell-copy">{t("{name} needs a newer version of this app.", { name: pc })}</p>
          <div className="relay-shell-actions">
            {state.platform !== null && <ExternalLink kind="link" className="btn btn-primary" href={STORE_PAGES[state.platform]}>{t("Open the store")}</ExternalLink>}
            {back ?? <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("Back")}</button>}
          </div>
        </>
      )}
      {state.kind === "forged" && (
        <>
          <h1 className="relay-shell-title">{t("This link is not {name}'s", { name: pc })}</h1>
          <p className="relay-shell-copy">{t("It carries a key that is not this PC's, so this device will not pair with it. To pair, scan a new QR code on the PC itself.")}</p>
          {state.mismatch && <KeyIds mismatch={state.mismatch} named="link" />}
          {back && <div className="relay-shell-actions">{back}</div>}
        </>
      )}
      {state.kind === "forgotten" && (
        <>
          <h1 className="relay-shell-title">{t("This phone forgot {name}", { name: pc })}</h1>
          <p className="relay-shell-copy">{t("The link you opened carried a different key, so it is not used to pair again. To pair, scan a new QR code on the PC itself.")}</p>
          {back && <div className="relay-shell-actions">{back}</div>}
        </>
      )}
      {iosTab && scoped && <p className="relay-shell-hint">{t("Add to Home Screen to stay paired: Safari may clear this page's storage after a week without a visit.")}</p>}
    </>
  );
}
