import { useEffect, useState } from "react";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";

const probes = new Map<string, Promise<boolean>>();

export function sharedSessionHistoryProbe(machineId: string, ask: () => Promise<boolean>): Promise<boolean> {
  const known = probes.get(machineId);
  if (known) return known;
  const probe = ask();
  probes.set(machineId, probe);
  probe.catch(() => { if (probes.get(machineId) === probe) probes.delete(machineId); });
  return probe;
}

export function forgetSessionHistoryProbe(machineId: string): void {
  probes.delete(machineId);
}

export function forgetSessionHistoryProbesOfPcsAway(machines: readonly { id: string; state: string }[]): void {
  for (const machineId of [...probes.keys()]) {
    if (!machines.some((machine) => machine.id === machineId && machine.state === "connected")) probes.delete(machineId);
  }
}

export function useSessionHistoryOffered(online: boolean): boolean {
  const machineId = useMachineId();
  const { sessionHistoryOffered } = useMachineApi();
  const [offered, setOffered] = useState(machineId === LOCAL_MACHINE);
  useEffect(() => {
    if (machineId === LOCAL_MACHINE || !online) return;
    let live = true;
    sharedSessionHistoryProbe(machineId, sessionHistoryOffered).then((answer) => { if (live) setOffered(answer); }, () => { });
    return () => { live = false; };
  }, [machineId, online, sessionHistoryOffered]);
  return offered;
}
