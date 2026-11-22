/** The machine list's rows and notices, and focus behavior shared with its add sheet. */
import "./MyMachines.css";
import { useLayoutEffect } from "react";
import type { FocusEvent, MouseEvent, ReactNode, RefObject } from "react";
import { ShieldAlert } from "lucide-react";
import type { MachineNotice } from "../lib/account/machinesView.ts";
import { useT } from "../lib/i18n.ts";
import type { Translate } from "../lib/i18n.ts";
import { machineOriginText, signerName, unreachableMember, whenText } from "./myMachinesWords.ts";

/**
 * While `open`, the page behind a dialog drawn on document.body takes no focus and is not read out:
 * the dialog's own trap holds Tab, and this keeps a screen reader's cursor out of the page too.
 */
export function useInertPage(open: boolean, inside: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const page = open ? inside.current?.closest<HTMLElement>(".relay-dash") ?? null : null;
    if (page === null) return;
    page.inert = true;
    return () => { page.inert = false; };
  }, [open, inside]);
}

/**
 * A dialog's onFocus: the control the keyboard lands on is brought into view. A dialog taller than the
 * window scrolls inside itself, and its trap moves the focus without scrolling (lib/useFocusTrap.ts).
 * A pointer's focus is left where it is, so nothing moves under a press.
 */
export function showFocused(event: FocusEvent<HTMLElement>): void {
  if (event.target.matches(":focus-visible")) event.target.scrollIntoView({ block: "nearest" });
}

export interface AccountCell {
  readonly label: string;
  readonly value: ReactNode;
  readonly dim?: boolean;
  /** the cell holds only a dash: where rows stack it is left out, since no column needs a placeholder there */
  readonly empty?: boolean;
}

export function AccountListHead({ main, cells }: { readonly main: string; readonly cells: readonly string[] }) {
  return (
    <div className="acct-list-head" aria-hidden="true">
      <span>{main}</span>
      {cells.map((cell) => <span key={cell}>{cell}</span>)}
      <span />
    </div>
  );
}

export interface AccountRowProps {
  readonly rowId: string;
  readonly state?: string;
  /** the state dot or the kind's icon: it stays beside the name however long the name is */
  readonly glyph?: ReactNode;
  readonly name: ReactNode;
  readonly cells: readonly AccountCell[];
  readonly why?: ReactNode;
  readonly action?: ReactNode;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
}

export function AccountRow({ rowId, state, glyph, name, cells, why, action, selected = false, onSelect }: AccountRowProps) {
  const className = ["acct-row", onSelect ? "is-clickable" : "", selected ? "is-selected" : ""].filter(Boolean).join(" ");
  const keepRowClick = (event: MouseEvent): void => { event.stopPropagation(); };
  return (
    <li className={className} data-row-id={rowId} data-row-state={state} onClick={onSelect}>
      <div className="acct-row-main">
        {glyph}
        <span className="acct-row-names">{name}</span>
      </div>
      <div className="acct-row-meta">
        {cells.map((cell) => (
          <span key={cell.label} className={cell.dim ? "acct-cell is-dim" : "acct-cell"} data-empty={cell.empty ? "" : undefined}>
            <span className="visually-hidden">{cell.label} </span>
            {cell.value}
          </span>
        ))}
      </div>
      {why != null && <p className="acct-row-why">{why}</p>}
      <div className="acct-row-act" onClick={keepRowClick}>{action}</div>
    </li>
  );
}

function machineNoticeText(notice: MachineNotice, t: Translate, now: number): string {
  const { machine, how } = notice;
  switch (how.kind) {
    case "invite": return t("{name} joined {when} with {invite}, {n} of {uses}.", { name: machine.name, when: whenText(how.joinedAt, now), invite: how.invite.label, n: how.nth, uses: how.invite.uses });
    case "paired": return t("{name} was added {when} by {device}.", { name: machine.name, when: whenText(how.addedAt, now), device: signerName(how.addedBy, t) });
    case "not-known": return `${machine.name}: ${machineOriginText(how, t, now)}`;
    default: return unreachableMember(how);
  }
}

export interface AccountNoticesProps {
  readonly notices: readonly MachineNotice[];
  readonly now: number;
  readonly onWasMe: (noticeId: string) => void;
}

export function AccountNotices({ notices, now, onWasMe }: AccountNoticesProps) {
  const t = useT();
  if (notices.length === 0) return null;
  return (
    <ul className="acct-notices" aria-label={t("Got in without this device")}>
      {notices.map((notice) => (
        <li key={notice.id} className="acct-notice" data-notice-id={notice.id}>
          <div className="acct-notice-lead">
            <ShieldAlert className="acct-notice-icon" aria-hidden="true" />
            <p className="acct-notice-text">{machineNoticeText(notice, t, now)}</p>
          </div>
          <div className="acct-notice-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onWasMe(notice.id)}>{t("It was me")}</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
