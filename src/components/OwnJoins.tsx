import { useEffect, useId, useState, type FormEvent } from "react";
import { Smartphone, X } from "lucide-react";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

import type { OwnJoinRequest } from "../../shared/machines.ts";
import { ApiError, approveOwnJoin, fetchOwnJoins } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { ADDED_POLL_MS } from "./AccountSection.tsx";

/**
 * The account joins waiting for this PC's own window (server/relay/routes.ts, /api/relay/joins), read every
 * ADDED_POLL_MS while `enabled` and the page shows, and at once whenever `again` changes. A 403, 404 or 405 is final:
 * a window that is not the PC's own, or a PC without the route, is not asked again.
 */
export function useOwnJoins(enabled: boolean, again = 0): readonly OwnJoinRequest[] {
  const [joins, setJoins] = useState<readonly OwnJoinRequest[]>([]);
  useEffect(() => {
    if (!enabled) { setJoins([]); return; }
    let live = true;
    let refused = false;
    const read = (): void => {
      if (refused || document.hidden) return;
      fetchOwnJoins().then((next) => { if (live) setJoins(next); }, (error: unknown) => {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 405)) refused = true;
        else console.warn("Ovis: the account joins could not be read", error instanceof Error ? error.name : error);
      });
    };
    read();
    const timer = setInterval(read, ADDED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [enabled, again]);
  return joins;
}

/** A join this PC cannot let in (`list_unknown`, server/relay/session.ts): nothing approves it here, and this is said instead. */
const listUnknown = (join: OwnJoinRequest): boolean => join.list_unknown === true;

/**
 * The account join waiting for this PC's own window that a member could also approve (it comes without its digits),
 * popped on the window by itself, one at a time, the oldest first: `joins` as useOwnJoins reads them, which it does only
 * in the PC's own window while the PC is not locked. Its person types the six digits the new device shows, and one
 * wrong entry ends that join. The field never takes the focus by itself: keys meant for a terminal must not land in it.
 * Not now hides the card in this window only; the join still lapses at its own deadline. `onDecided`: read them again.
 * A join this PC cannot let in (listUnknown), a first join too, pops with no field: the card says to update that app.
 */
export function OwnJoinCard({ joins, onDecided }: { readonly joins: readonly OwnJoinRequest[]; readonly onDecided: () => void }) {
  const t = useT();
  const id = useId();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** what became of a join this card ended (a wrong number, or one no longer waiting), told until closed */
  const [ended, setEnded] = useState<string | null>(null);
  const join = joins.find((each) => (each.digits === undefined || listUnknown(each)) && !hidden.has(each.id));
  if (join === undefined && ended === null) return null;
  const approve = (asked: OwnJoinRequest) => (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("digits") as HTMLInputElement | null;
    const digits = (field?.value ?? "").replace(/\s/g, "");
    if (!/^[0-9]{6}$/.test(digits)) { setProblem(t("Type the six digits {name} shows.", { name: asked.label })); return; }
    setProblem(null);
    setBusy(true);
    approveOwnJoin(asked.id, digits).then(() => setEnded(null), (error: unknown) => {
      const code = error instanceof ApiError ? error.code : null;
      if (code === "wrong_digits") { setEnded(t("That is not the number {name} shows. It was not let in; it can ask again.", { name: asked.label })); return; }
      if (code === "relay_pairing_gone") { setEnded(t("{name} is no longer waiting.", { name: asked.label })); return; }
      if (code === "list_unknown") { setEnded(t("{name} cannot be let in here: this PC lets devices into your account by its signed list, and {name} asked as an Ovis older than 0.5.10 does. Update Ovis on {name}, then have it ask to join again.", { name: asked.label })); return; }
      setProblem(t("Could not reach this PC. Try again."));
    }).finally(() => { setBusy(false); onDecided(); });
  };
  return (
    <div className="update-notice is-paired device-notice own-join-card" role="status" data-testid="own-join-card" {...(join ? { "data-join": join.id } : {})}>
      <Smartphone aria-hidden="true" />
      <span className="device-notice-text">
        {ended !== null && <span className="account-error" role="alert">{ended}</span>}
        {join !== undefined && listUnknown(join) && (
          <>
            <span>{t("\"{name}\" asks to join your account", { name: join.label })}</span>
            <span>{t("{name} cannot be let in here: this PC lets devices into your account by its signed list, and {name} asked as an Ovis older than 0.5.10 does. Update Ovis on {name}, then have it ask to join again.", { name: join.label })}</span>
            <button type="button" className="btn" onClick={() => setHidden((current) => new Set(current).add(join.id))}>{t("Not now")}</button>
          </>
        )}
        {join !== undefined && !listUnknown(join) && (
          <>
            <span>{t("\"{name}\" asks to join your account", { name: join.label })}</span>
            <form key={join.id} className="relay-shell-code-form" onSubmit={approve(join)}>
              <label className="field-label" htmlFor={`${id}-${join.id}`}>{t("Number on {name}", { name: join.label })}</label>
              <input id={`${id}-${join.id}`} name="digits" className="input relay-shell-code-input" inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="off" required />
              <button type="submit" className="btn btn-primary" disabled={busy}>{t("Approve")}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setProblem(null); setHidden((current) => new Set(current).add(join.id)); }}>{t("Not now")}</button>
            </form>
            {problem !== null && <span className="account-error" role="alert">{problem}</span>}
          </>
        )}
      </span>
      {join === undefined && <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Close")} title={t("Close")} onClick={() => setEnded(null)}><X aria-hidden="true" /></button>}
    </div>
  );
}

/**
 * Account joins no pairing window invited, listed in this PC's own window only (server/relay/routes.ts, /api/relay/joins):
 * nothing pops up, and the owner lets one in by typing the digits its screen shows. A wrong number ends that join. A
 * first join, which comes with its digits, is asked on the window's prompt instead (RelayPairingPrompt, firstJoinPrompts).
 * A join this PC cannot let in (listUnknown), a first join too, is listed with why and no way to approve it.
 */
export function OwnJoins() {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checks, setChecks] = useState(0);
  const id = useId();
  const joins = useOwnJoins(true, checks).filter((join) => join.digits === undefined || listUnknown(join));

  const approve = (join: OwnJoinRequest) => (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("digits") as HTMLInputElement | null;
    const digits = (field?.value ?? "").replace(/\s/g, "");
    // a number of another length is sent nowhere: the join still waits, and so does the field
    if (!/^[0-9]{6}$/.test(digits)) { setProblem(t("Type the six digits {name} shows.", { name: join.label })); return; }
    setProblem(null);
    // what comes back is about this join alone: another one opened meanwhile keeps its field and what was typed there
    const closeMine = (): void => setOpen((current) => current === join.id ? null : current);
    approveOwnJoin(join.id, digits).then(closeMine, (error: unknown) => {
      const code = error instanceof ApiError ? error.code : null;
      // only an answer that says so ends the join on this screen: a failure on the way leaves it waiting, and the field open
      if (code === "wrong_digits") { setProblem(t("That is not the number {name} shows. It was not let in; it can ask again.", { name: join.label })); closeMine(); return; }
      if (code === "relay_pairing_gone") { setProblem(t("{name} is no longer waiting.", { name: join.label })); closeMine(); return; }
      if (code === "list_unknown") { setProblem(t("{name} cannot be let in here: this PC lets devices into your account by its signed list, and {name} asked as an Ovis older than 0.5.10 does. Update Ovis on {name}, then have it ask to join again.", { name: join.label })); closeMine(); return; }
      setProblem(t("Could not reach this PC. Try again."));
    }).finally(() => setChecks((count) => count + 1));
  };

  if (joins.length === 0 && problem === null) return null;
  return (
    <div className="settings-item own-joins" data-testid="own-joins">
      {joins.map((join) => (
        <div key={join.id} className="settings-row" data-join={join.id}>
          <span className="settings-label">{t("A device of your account asks to join")}
            <span className="settings-description"> · {join.label} · {lastSeen(join.asked_at, Date.now())}</span>
          </span>
          {listUnknown(join) ? (
            <span className="settings-description">{t("{name} cannot be let in here: this PC lets devices into your account by its signed list, and {name} asked as an Ovis older than 0.5.10 does. Update Ovis on {name}, then have it ask to join again.", { name: join.label })}</span>
          ) : open === join.id ? (
            <form className="relay-shell-code-form" onSubmit={approve(join)}>
              <label className="field-label" htmlFor={`${id}-${join.id}`}>{t("Number on {name}", { name: join.label })}</label>
              <input id={`${id}-${join.id}`} name="digits" className="input relay-shell-code-input" inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" required autoFocus />
              <button type="submit" className="btn btn-primary">{t("Approve")}</button>
              <button type="button" className="btn" onClick={() => { setProblem(null); setOpen(null); }}>{t("Cancel")}</button>
            </form>
          ) : (
            <button type="button" className="btn" onClick={() => { setProblem(null); setOpen(join.id); }}>{t("Type the number")}</button>
          )}
        </div>
      ))}
      {problem !== null && <p className="settings-condition" role="alert">{problem}</p>}
    </div>
  );
}
