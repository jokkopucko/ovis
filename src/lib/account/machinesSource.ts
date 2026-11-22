/**
 * THE seam between the "My machines" screens and what feeds them: the only file that knows which
 * source that is. Today: the account's directory and this device's pairings and checks, as the
 * hosted shell already keeps them (todayMachines.ts). When the account's signed list exists, it
 * replaces today's source here, and nothing else changes.
 */
import { useRef } from "react";
import type { MachinesActions, MachinesView } from "./machinesView.ts";
import type { MyPc } from "./myPcs.ts";
import type { PcStatus } from "../relay/pcStatus.ts";
import { foldChecks, todayMachinesView, type MachineCheck } from "./todayMachines.ts";

/** What the hosted shell already holds: no source may open a connection of its own to draw the list. */
export interface ShellMachines {
  /** the signed-in account's rows; null while its directory is read */
  readonly pcs: readonly MyPc[] | null;
  /** this device's latest check of each saved PC, by server id */
  readonly status: ReadonlyMap<string, PcStatus>;
}

/** What the hosted shell can do for a machine today. */
export interface ShellDeeds {
  /** goes to the PC's own page, where its terminals open */
  readonly open: (machineId: string) => void;
  /** checks the PC again now */
  readonly check: (machineId: string) => void;
  /** opens today's way in for a PC this device is not let in to */
  readonly join: (machineId: string) => void;
}

/** The view and its actions; the view is null while there is nothing to draw it from yet. */
export function useMachinesSource(shell: ShellMachines, deeds: ShellDeeds): { readonly view: MachinesView | null; readonly actions: MachinesActions } {
  // what was known survives a re-check (foldChecks)
  const known = useRef<ReadonlyMap<string, MachineCheck>>(new Map());
  const checks = foldChecks(known.current, shell.status, new Date().toISOString());
  known.current = checks;
  return {
    view: shell.pcs === null ? null : todayMachinesView(shell.pcs, checks),
    actions: {
      openMachine: deeds.open,
      retryMachine: deeds.check,
      joinMachine: deeds.join,
    },
  };
}
