import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MachineSessionRegistry } from "./machineSession.ts";

const MachineSessionsContext = createContext<MachineSessionRegistry | null>(null);
export const useMachineSessions = () => useContext(MachineSessionsContext);

export function MachineSessionsProvider({ machineIds, sessions: provided, children }: { machineIds: readonly string[]; sessions?: MachineSessionRegistry; children: ReactNode }) {
  const [owned] = useState(() => new MachineSessionRegistry());
  const sessions = provided ?? owned;
  const ids = JSON.stringify(machineIds);
  useEffect(() => {
    if (machineIds.length) sessions.retainMachines(new Set(machineIds));
  }, [sessions, ids]);
  useEffect(() => provided ? undefined : () => owned.closeAll(), [provided, owned]);
  return <MachineSessionsContext.Provider value={sessions}>{children}</MachineSessionsContext.Provider>;
}
