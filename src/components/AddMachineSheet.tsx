/**
 * Add a machine (DESIGN.md "My machines"; contract 1 v3, section 4): choose what the line lets in,
 * then two boxes, shown once with what pasting the line allows: the command to run on the machine,
 * and under "Paste this line when it asks" the join line, which is never part of a command. Then
 * the wait until the machine joined. The line lives in the `invite` prop only while the sheet is
 * open; closing before it was copied asks first, since no screen can show it again.
 */
import "./RelayShell.css";
import "./AddMachineSheet.css";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MachineInviteFlow } from "../lib/account/machinesView.ts";
import { copyText } from "../lib/clipboard.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import type { Translate } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { showFocused } from "./MyMachinesParts.tsx";
import { fullTime } from "./myMachinesWords.ts";
import { StatusDot } from "./StatusDot.tsx";

const HOURS = [1, 4, 24, 168] as const;
type Hours = (typeof HOURS)[number];
const DEFAULT_HOURS: Hours = 4;
const LIMIT_MIN = 2;
const LIMIT_MAX = 256;

function hoursLabel(hours: Hours, time: string, t: Translate): string {
  switch (hours) {
    case 1: return t("1 hour, until {time}", { time });
    case 4: return t("4 hours, until {time}", { time });
    case 24: return t("1 day, until {time}", { time });
    case 168: return t("7 days, until {time}", { time });
  }
}

export interface AddMachineSheetProps {
  readonly flow: MachineInviteFlow | undefined;
  readonly now: number;
  readonly onOpenMachine: (machineId: string) => void;
  readonly onClose: () => void;
}

const ADD_COMMAND = "ovis add";

export function AddMachineSheet({ flow, now, onOpenMachine, onClose }: AddMachineSheetProps) {
  const invite = flow?.invite ?? null;
  const fromTerminal = flow === undefined;
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const phone = useMediaQuery(SHEET_QUERY);
  const [use, setUse] = useState<"single-use" | "reusable">("single-use");
  const [limit, setLimit] = useState("5");
  const [hours, setHours] = useState<Hours>(DEFAULT_HOURS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [hasOvis, setHasOvis] = useState(true);
  const [askClose, setAskClose] = useState(false);
  const line = useRef<HTMLPreElement>(null);
  const command = useRef<HTMLPreElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true);

  const machines = Number(limit);
  const limitValid = use === "single-use" || (Number.isInteger(machines) && machines >= LIMIT_MIN && machines <= LIMIT_MAX);
  const joined = invite?.joined ?? [];
  const full = invite !== null && (invite.use.kind === "single-use" ? joined.length >= 1 : joined.length >= invite.use.limit);
  const lineUnsaved = invite !== null && !copied && joined.length === 0;

  const requestClose = (): void => { if (busy) return; if (lineUnsaved) setAskClose(true); else onClose(); };
  const latestClose = useRef(requestClose);
  latestClose.current = requestClose;
  useSheetSwipe(surface, busy ? null : () => latestClose.current());
  usePhoneSheetBack(() => { if (busy) return false; latestClose.current(); return lineUnsaved ? false : undefined; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || askClose || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      latestClose.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [askClose, surface]);

  const step = fromTerminal ? "terminal" : invite === null ? "choose" : "line";
  useLayoutEffect(() => {
    const node = surface.current;
    if (node !== null && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
  }, [step, surface]);

  const copy = (): void => {
    const text = fromTerminal ? ADD_COMMAND : invite?.line;
    if (text === undefined) return;
    void copyText(text, line.current).then((ok) => { if (ok) setCopied(true); });
  };
  const runs = invite === null ? null : hasOvis ? invite.commands.withOvis : invite.commands.withoutOvis;
  const copyCommand = (): void => {
    if (runs === null) return;
    void copyText(runs, command.current).then((ok) => { if (ok) setCommandCopied(true); });
  };

  const inOrder = (secondary: ReactNode, primary: ReactNode): ReactNode => phone ? <>{primary}{secondary}</> : <>{secondary}{primary}</>;
  let title: string;
  let sub: string;
  let body: ReactNode;
  let footer: ReactNode;
  if (flow === undefined) {
    title = t("Add a machine");
    sub = t("Run this in a terminal on the machine.");
    body = (
      <div className="add-machine-body">
        <div className="relay-shell-command-row">
          <pre ref={line} className="relay-shell-command add-machine-line" data-add-command=""><code>{ADD_COMMAND}</code></pre>
          <button type="button" className={copied ? "btn add-machine-copy" : "btn btn-primary add-machine-copy"} data-action="copy-command" onClick={copy}>{copied ? t("Copied") : t("Copy")}</button>
        </div>
        <p className="add-machine-once">{t("It signs the machine in to your account with a code you enter on any device, then shows a QR code: scan it with a device signed in to this account. The machine then shows up in this list.")}</p>
      </div>
    );
    footer = <button key="close" type="button" className="btn" onClick={requestClose}>{t("Close")}</button>;
  } else if (invite === null) {
    const make = async (): Promise<void> => {
      setBusy(true);
      setError(null);
      try { await flow.makeInvite({ use: use === "single-use" ? { kind: "single-use" } : { kind: "reusable", limit: machines }, hours }); }
      catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setBusy(false); }
    };
    title = t("Add a machine");
    sub = t("Make a join line here. On the machine, run the command it shows, then paste the line when it asks.");
    body = (
      <form id={`${id}-form`} className="add-machine-body" onSubmit={(event) => { event.preventDefault(); if (limitValid && !busy) void make(); }}>
        <div className="field">
          <span className="field-label" id={`${id}-use`}>{t("Kind of invite")}</span>
          <div className="segmented" role="group" aria-labelledby={`${id}-use`}>
            <button type="button" aria-pressed={use === "single-use"} onClick={() => setUse("single-use")}>{t("Single-use")}</button>
            <button type="button" aria-pressed={use === "reusable"} onClick={() => setUse("reusable")}>{t("Reusable")}</button>
          </div>
          <p className="add-machine-hint">{use === "single-use" ? t("One machine joins with it, then it stops working.") : t("Several machines join with it, until its limit or its end time. Whoever holds the line can add machines with it, never devices.")}</p>
        </div>
        {use === "reusable" && (
          <div className="field">
            <label className="field-label" htmlFor={`${id}-limit`}>{t("Machines it lets in")}</label>
            <input id={`${id}-limit`} className="input add-machine-limit" type="number" inputMode="numeric" min={LIMIT_MIN} max={LIMIT_MAX} value={limit} required
              aria-describedby={`${id}-limit-hint`} onChange={(event) => setLimit(event.target.value)} />
            <span className="field-hint" id={`${id}-limit-hint`}>{t("From {min} to {max}.", { min: LIMIT_MIN, max: LIMIT_MAX })}</span>
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor={`${id}-hours`}>{t("Works for")}</label>
          <select id={`${id}-hours`} className="select" value={hours} onChange={(event) => setHours(HOURS.find((value) => String(value) === event.target.value) ?? DEFAULT_HOURS)}>
            {HOURS.map((value) => <option key={value} value={value}>{hoursLabel(value, fullTime(new Date(now + value * 3_600_000).toISOString(), locale), t)}</option>)}
          </select>
        </div>
        {error !== null && <p className="add-machine-error" role="alert">{error}</p>}
      </form>
    );
    footer = inOrder(
      <button key="cancel" type="button" className="btn" disabled={busy} onClick={requestClose}>{t("Cancel")}</button>,
      <button key="make" type="submit" form={`${id}-form`} className="btn btn-primary" data-action="make-line" disabled={!limitValid || busy} aria-busy={busy || undefined}>{t("Make the line")}</button>,
    );
  } else {
    const until = fullTime(invite.endsAt, locale);
    const first = joined[0];
    title = t("Add this machine to your account");
    sub = t("Run the command on the machine. When it asks, paste the line.");
    body = (
      <div className="add-machine-body">
        <div className="field">
          <span className="field-label" id={`${id}-command`}>{t("Run this on the machine")}</span>
          <div className="segmented" role="group" aria-labelledby={`${id}-command`}>
            <button type="button" aria-pressed={hasOvis} onClick={() => { setHasOvis(true); setCommandCopied(false); }}>{t("It has Ovis")}</button>
            <button type="button" aria-pressed={!hasOvis} onClick={() => { setHasOvis(false); setCommandCopied(false); }}>{t("It has no Ovis yet")}</button>
          </div>
          <div className="relay-shell-command-row">
            <pre ref={command} className="relay-shell-command" data-join-command=""><code>{runs}</code></pre>
            <button type="button" className="btn add-machine-copy" data-action="copy-command" aria-label={t("Copy the command")} onClick={copyCommand}>{commandCopied ? t("Copied") : t("Copy")}</button>
          </div>
        </div>
        <div className="field">
          <span className="field-label" id={`${id}-line`}>{t("Paste this line when it asks")}</span>
          <div className="relay-shell-command-row">
            <pre ref={line} className="relay-shell-command add-machine-line" data-join-line=""><code>{invite.line}</code></pre>
            <button type="button" className={lineUnsaved ? "btn btn-primary add-machine-copy" : "btn add-machine-copy"} data-action="copy-line" aria-label={t("Copy the line")} onClick={copy}>{copied ? t("Copied") : t("Copy")}</button>
          </div>
        </div>
        <p className="add-machine-once">
          {invite.use.kind === "single-use" ? t("It lets one machine join until {time}.", { time: until }) : t("It lets up to {n} machines join until {time}.", { n: invite.use.limit, time: until })}
          {" "}{t("It is shown only now: once you close this, no screen can show it again.")}
        </p>
        <p className="add-machine-consent" data-consent="">{t("The line joins the machine's engine session under the user account you paste it in: the devices you approve in your account can see and type in every terminal of that session, start new ones, read and change files that account can reach, upload, run plugin actions and install agents; Ovis does not restart the engine.")}</p>
        <ul className="add-machine-progress" role="status" data-add-state={joined.length === 0 ? "waiting" : full ? "joined" : "joining"}>
          {joined.map((machine) => <li key={machine.id} className="add-machine-status"><StatusDot state="ready" size="inline" />{t("{name} joined.", { name: machine.name })}</li>)}
          {!full && <li className="add-machine-status"><StatusDot state="checking" size="inline" />{joined.length === 0 ? t("Waiting for the machine…") : t("Waiting for the next machine…")}</li>}
        </ul>
      </div>
    );
    const close = <button key="close" type="button" className="btn" onClick={requestClose}>{t("Close")}</button>;
    footer = full && first !== undefined
      ? inOrder(close, <button key="open" type="button" className="btn btn-primary" data-action="open-joined" onClick={() => onOpenMachine(first.id)}>{t("Open {name}", { name: first.name })}</button>)
      : close;
  }

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div ref={surface} className="modal add-machine-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-sub`} tabIndex={-1} onFocus={showFocused} data-add-step={step}>
        <header className="modal-header add-machine-head">
          <h2 className="modal-title" id={`${id}-title`}>{title}</h2>
          <p className="add-machine-sub" id={`${id}-sub`}>{sub}</p>
        </header>
        <div className="modal-body">{body}</div>
        <footer className="modal-footer add-machine-footer">{footer}</footer>
      </div>
      {askClose && invite !== null && (
        <ConfirmDialog title={t("Close without copying the line?")}
          body={t("No screen can show the line again. Its invite stays open until {time}: revoke it under Invites if you will not use it.", { time: fullTime(invite.endsAt, locale) })}
          confirmLabel={t("Close")} onClose={() => setAskClose(false)} onConfirm={async () => { onClose(); }} />
      )}
    </div>,
    document.body,
  );
}
