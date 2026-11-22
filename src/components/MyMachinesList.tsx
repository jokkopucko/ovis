/**
 * The one list of "My machines" (DESIGN.md "My machines"): every machine and PC of the account with
 * its state word, why, its engine and the way this device reaches it. What needs a look sorts first.
 * PCs follow the machines under their own head, in the same row with the same actions.
 */
import type { ReactNode } from "react";
import type { Machine } from "../lib/account/machinesView.ts";
import { useT } from "../lib/i18n.ts";
import { AccountListHead, AccountRow } from "./MyMachinesParts.tsx";
import type { AccountCell } from "./MyMachinesParts.tsx";
import { engineText, machineDot, machineOrder, machineStateWord, machineWhy, routeText, unreachableMember } from "./myMachinesWords.ts";
import { StatusDot } from "./StatusDot.tsx";

export interface MyMachinesListProps {
  readonly machines: readonly Machine[];
  readonly selectedId: string | null;
  readonly now: number;
  /** false on a device that only watches: the empty list then offers no Add */
  readonly canAdd: boolean;
  readonly onSelect: (machineId: string) => void;
  readonly onOpen: (machineId: string) => void;
  readonly onRetry: (machineId: string) => void;
  readonly onAdd: () => void;
  /** the source's way in to a machine this device is not let in to; Join is offered only with it */
  readonly onJoin?: ((machineId: string) => void) | undefined;
  /** a machine is added from a terminal on it (today's source), not by a line made here */
  readonly addsFromTerminal?: boolean | undefined;
}

export function MyMachinesList({ machines, selectedId, now, canAdd, onSelect, onOpen, onRetry, onAdd, onJoin, addsFromTerminal = false }: MyMachinesListProps) {
  const t = useT();
  if (machines.length === 0) {
    return (
      <div className="acct-empty" data-empty="machines">
        <h2 className="acct-empty-title">{t("No machines yet")}</h2>
        <p className="acct-empty-copy">{addsFromTerminal
          ? t("A machine is a server or VM that keeps its own terminal engine. To add one, run ovis add in a terminal on it: it then shows up in this list.")
          : t("A machine is a server or VM that keeps its own terminal engine. To add one, make a join line here, run the command it shows on the machine and paste the line when it asks: the machine then shows up in this list.")}</p>
        {canAdd && <button type="button" className="btn btn-primary" data-action="add-machine" onClick={onAdd}>{t("Add a machine")}</button>}
      </div>
    );
  }

  const action = (machine: Machine): ReactNode => {
    const open = <button type="button" className="btn" data-row-action="open" aria-label={t("Open {name}", { name: machine.name })} onClick={() => onOpen(machine.id)}>{t("Open")}</button>;
    const details = <button type="button" className="btn" data-row-action="details" aria-label={t("Details of {name}", { name: machine.name })} onClick={() => onSelect(machine.id)}>{t("Details")}</button>;
    switch (machine.state.kind) {
      case "ready": case "unchecked": return open;
      // a machine behind still opens for a device it knows (contract 1 v3, F3.5)
      case "needs-update": return machine.state.knowsThisDevice ? open : details;
      case "unreachable": return <button type="button" className="btn" data-row-action="retry" aria-label={t("Try to reach {name} again", { name: machine.name })} onClick={() => onRetry(machine.id)}>{t("Try again")}</button>;
      case "needs-approval":
        if (machine.state.canAsk && onJoin) return <button type="button" className="btn" data-row-action="join" aria-label={t("Join {name}", { name: machine.name })} onClick={() => onJoin(machine.id)}>{t("Join|machine")}</button>;
        return details;
      case "offline": case "joining": case "removed": return details;
      default: return unreachableMember(machine.state);
    }
  };

  const row = (machine: Machine): ReactNode => {
    const selected = machine.id === selectedId;
    const cells: AccountCell[] = [
      { label: t("State|my machines"), value: machineStateWord(machine.state, t) },
      { label: t("Engine"), value: engineText(machine.engine, t), dim: true },
      { label: t("Route|my machines"), value: machine.state.kind === "ready" ? routeText(machine.state.route, t) : "—", dim: true, empty: machine.state.kind !== "ready" },
    ];
    return (
      <AccountRow key={machine.id} rowId={machine.id} state={machine.state.kind} selected={selected} onSelect={() => onSelect(machine.id)}
        glyph={<StatusDot state={machineDot(machine.state)} />}
        name={<button type="button" className="acct-name-btn" aria-current={selected ? "true" : undefined} onClick={(event) => { event.stopPropagation(); onSelect(machine.id); }}>{machine.name}</button>}
        cells={cells} why={machineWhy(machine, t, now)} action={action(machine)} />
    );
  };

  const ordered = machineOrder(machines);
  const servers = ordered.filter((machine) => machine.kind === "machine");
  const pcs = ordered.filter((machine) => machine.kind === "pc");
  return (
    <div className="acct-list" data-list="machines">
      <AccountListHead main={t("Name")} cells={[t("State|my machines"), t("Engine"), t("Route|my machines")]} />
      {servers.length > 0 && <ul className="acct-rows" aria-label={t("My machines")}>{servers.map(row)}</ul>}
      {servers.length > 0 && pcs.length > 0 && <h2 className="relay-dash-h">{t("My PCs")}</h2>}
      {pcs.length > 0 && <ul className="acct-rows" tabIndex={-1} aria-label={t("My PCs")}>{pcs.map(row)}</ul>}
    </div>
  );
}
