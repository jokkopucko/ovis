/**
 * A machine's details (DESIGN.md "My machines"): its state and why, its engine and route, how it
 * came in. The panel and its rows are RelayPcDetails'
 * (RelayPcDetails.css): beside the list from 1100px, a full view with Back below.
 */
import "./RelayPcDetails.css";
import "./MyMachines.css";
import { useEffect } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Machine, MachineOrigin } from "../lib/account/machinesView.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import type { Translate } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { KeyId } from "./KeyId.tsx";
import { engineText, fullTime, machineDot, machineOriginText, machineOriginTime, machineStateWord, machineWhy, opensFromHere, routeText, signerName, unreachableMember, whenText } from "./myMachinesWords.ts";
import { StatusDot } from "./StatusDot.tsx";

export const NARROW_DETAILS_QUERY = "(max-width: 1099px)";

/** Who or what brought the machine in, when known. */
function cameInBy(origin: MachineOrigin, t: Translate): ReactNode {
  switch (origin.kind) {
    case "invite": return <span className="relay-pc-details-value">{t("Invite {label}", { label: origin.invite.label })}</span>;
    case "paired": return <span className="relay-pc-details-value">{signerName(origin.addedBy, t)}</span>;
    case "not-known": return null;
    default: return unreachableMember(origin);
  }
}

export interface MyMachineDetailsProps {
  readonly machine: Machine;
  readonly now: number;
  /** true while a dialog of the page is up: Escape is that dialog's then */
  readonly blocked: boolean;
  readonly onClose: () => void;
  readonly onOpen: (machineId: string) => void;
  readonly onRetry: (machineId: string) => void;
  /** the source's way in to a machine this device is not let in to; Join is offered only with it */
  readonly onJoin?: ((machineId: string) => void) | undefined;
}

export function MyMachineDetails({ machine, now, blocked, onClose, onOpen, onRetry, onJoin }: MyMachineDetailsProps) {
  const t = useT();
  const locale = useLocale();
  const fullView = useMediaQuery(NARROW_DETAILS_QUERY);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || blocked || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, blocked]);

  const { state, cameIn } = machine;
  const reason = machineWhy(machine, t, now);
  const cameAt = machineOriginTime(cameIn);

  return (
    <aside className={fullView ? "relay-pc-details is-full-view" : "relay-pc-details"} data-machine-details={machine.id} aria-label={machine.name}>
      <header className="relay-pc-details-bar">
        {fullView && <button type="button" className="btn btn-ghost relay-pc-details-back" onClick={onClose}><ArrowLeft aria-hidden="true" /><span>{t("Back")}</span></button>}
        <div className="relay-pc-details-location">
          <StatusDot state={machineDot(state)} />
          <h2 className="relay-pc-details-title" tabIndex={-1}>{machine.name}</h2>
        </div>
        {!fullView && <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>}
      </header>

      <div className="relay-pc-details-body">
        <dl className="relay-pc-details-fields">
          <div className="relay-pc-details-row">
            <dt>{t("State|my machines")}</dt>
            <dd>
              <span className="relay-pc-details-value">{machineStateWord(state, t)}</span>
              {reason !== null && <small className="relay-pc-details-sub">{reason}</small>}
            </dd>
          </div>
          <div className="relay-pc-details-row">
            <dt>{t("Engine")}</dt>
            <dd>
              <span className="relay-pc-details-value">{engineText(machine.engine, t)}</span>
              {machine.engine === "not-seen" && <small className="relay-pc-details-sub">{t("Ovis does not start or restart the engine: start herdr or herdr-core on the machine.")}</small>}
            </dd>
          </div>
          <div className="relay-pc-details-row">
            <dt>{t("Route|my machines")}</dt>
            <dd className="relay-pc-details-tabular">{state.kind === "ready" ? routeText(state.route, t) : "—"}</dd>
          </div>
          <div className="relay-pc-details-row">
            <dt>{t("Kind")}</dt>
            <dd>{machine.kind === "pc" ? t("PC") : t("Machine: a server or VM with no screen")}</dd>
          </div>
          <div className="relay-pc-details-row">
            <dt>{t("Came in")}</dt>
            <dd className="relay-pc-details-tabular">
              {cameInBy(cameIn, t)}
              <small className="relay-pc-details-sub">{machineOriginText(cameIn, t, now)}</small>
              {cameAt !== null && <small className="relay-pc-details-sub"><time dateTime={cameAt}>{fullTime(cameAt, locale)}</time></small>}
            </dd>
          </div>
          {machine.runsOwnOvis && (
            <div className="relay-pc-details-row">
              <dt>{t("Own Ovis")}</dt>
              <dd>
                <span className="relay-pc-details-value">{t("Serves its own Ovis page too")}</span>
                <small className="relay-pc-details-sub">{t("It stays one entry in this list.")}</small>
              </dd>
            </div>
          )}
          {machine.list !== undefined && (
            <div className="relay-pc-details-row" data-machine-list="">
              <dt>{t("Account list")}</dt>
              <dd className="relay-pc-details-tabular">{machine.list.polledAt === null ? t("Not read in full yet") : t("Last read in full {when}", { when: whenText(machine.list.polledAt, now) })}</dd>
            </div>
          )}
          <div className="relay-pc-details-row">
            <dt>{t("Key ID|my machines")}</dt>
            <dd className="relay-pc-details-key"><KeyId id={machine.id} label={t("Key ID|my machines")} /></dd>
          </div>
        </dl>

        <div className="relay-pc-details-actions">
          {opensFromHere(state) && <button type="button" className="btn" data-action="open-machine" onClick={() => onOpen(machine.id)}>{t("Open")}</button>}
          {state.kind === "needs-approval" && state.canAsk && onJoin && <button type="button" className="btn" data-action="join-machine" onClick={() => onJoin(machine.id)}>{t("Join|machine")}</button>}
          {(state.kind === "unreachable" || (state.kind === "unchecked" && !state.checking)) && <button type="button" className="btn" data-action="retry-machine" onClick={() => onRetry(machine.id)}>{t("Try again")}</button>}
        </div>
      </div>
    </aside>
  );
}
