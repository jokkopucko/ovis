import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MachineSessionRegistry } from "./machineSession.ts";

const MachineSessionsContext = createContext<MachineSessionRegistry | null>(null);
export const useMachineSessions = () => useContext(MachineSessionsContext);

/** Authenticated app lifetime, across PC and pane switches. A terminal owns only its attach. */
export function MachineSessionsProvider({ machineIds, sessions: provided, children }: { machineIds: readonly string[]; sessions?: MachineSessionRegistry; children: ReactNode }) {
  const [owned] = useState(() => new MachineSessionRegistry());
  const sessions = provided ?? owned;
  const ids = JSON.stringify(machineIds);
  useEffect(() => {
    // An initial empty roster is not evidence that every PC was removed.
    if (machineIds.length) sessions.retainMachines(new Set(machineIds));
  }, [sessions, ids]);
  // a registry handed in is closed by whoever created it, which may still be using it
  useEffect(() => provided ? undefined : () => owned.closeAll(), [provided, owned]);
  return <MachineSessionsContext.Provider value={sessions}>{children}</MachineSessionsContext.Provider>;
}
