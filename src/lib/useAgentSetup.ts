import { useEffect, useReducer, useRef, useState } from "react";

import type { AgentCatalogRow, AgentTabStarted } from "../../shared/agent-catalog.ts";
import { fetchAgentCatalog, startAgentInstall } from "./api.ts";
import { setupStep, type SetupStep } from "./agentSetup.ts";

const DETECT_EVERY_MS = 3000;

export interface AgentSetupOptions {
  agent: AgentCatalogRow;
  machineId?: string;
  initial?: SetupStep;
  onRow?: (row: AgentCatalogRow) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function useAgentSetup({ agent, machineId = "local", initial = { kind: "idle" }, onRow }: AgentSetupOptions) {
  const onRowRef = useRef(onRow);
  onRowRef.current = onRow;
  const [step, dispatch] = useReducer(setupStep, initial);

  useEffect(() => {
    if (step.kind !== "installing") return;
    const abort = new AbortController();
    const read = () => void fetchAgentCatalog(machineId, abort.signal)
      .then((catalog) => { if (abort.signal.aborted) return; const row = catalog.agents.find((candidate) => candidate.id === agent.id); if (row) { onRowRef.current?.(row); dispatch({ type: "detected", row }); } })
      .catch(() => {});
    const timer = setInterval(read, DETECT_EVERY_MS);
    read();
    return () => { clearInterval(timer); abort.abort(); };
  }, [step.kind, machineId, agent.id]);

  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ask = (send: () => Promise<AgentTabStarted>, started: (tab: AgentTabStarted) => void): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    void send().then((tab) => { if (alive.current) started(tab); }, (error) => { if (alive.current) dispatch({ type: "failed", message: message(error) }); }).finally(() => {
      inFlight.current = false;
      if (alive.current) setPending(false);
    });
  };
  const install = () => ask(() => startAgentInstall(agent.id, machineId), (tab) => dispatch({ type: "install-started", tab }));
  return { step, dispatch, pending, install };
}
