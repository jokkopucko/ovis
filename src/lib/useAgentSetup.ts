import { useEffect, useReducer, useRef, useState } from "react";

import type { AgentCatalogRow, AgentTabStarted } from "../../shared/agent-catalog.ts";
import { fetchAgentCatalog, startAgentInstall, startAgentSignIn } from "./api.ts";
import { setupStep, type SetupStep } from "./agentSetup.ts";

/** How often the catalog is read again while an install runs in its tab. */
const DETECT_EVERY_MS = 3000;

export interface AgentSetupOptions {
  /** the agent, as GET /api/agent-catalog answered it for `machineId` */
  agent: AgentCatalogRow;
  machineId?: string;
  /** a step to start from (tests, the demo's screenshots) */
  initial?: SetupStep;
  /** told each step it moves to */
  onStep?: (step: SetupStep) => void;
  /** each answer the install's catalog reads give for the agent */
  onRow?: (row: AgentCatalogRow) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * One agent's setup, Install then Sign in: each runs the PC's own official command in a terminal
 * tab, and installed is decided by reading the catalog again, never by how the tab ended. Shared by
 * the agent setup card and the setup guide's tiles.
 */
export function useAgentSetup({ agent, machineId = "local", initial = { kind: "idle" }, onStep, onRow }: AgentSetupOptions) {
  const onRowRef = useRef(onRow);
  onRowRef.current = onRow;
  const [step, dispatch] = useReducer(setupStep, initial);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  useEffect(() => { onStepRef.current?.(step); }, [step]);

  useEffect(() => {
    if (step.kind !== "installing") return;
    const abort = new AbortController();
    const read = () => void fetchAgentCatalog(machineId, abort.signal)
      // an answer already on its way when the watch ended (the tile gone, the install over) tells nothing
      .then((catalog) => { if (abort.signal.aborted) return; const row = catalog.agents.find((candidate) => candidate.id === agent.id); if (row) { onRowRef.current?.(row); dispatch({ type: "detected", row }); } })
      .catch(() => { /* the next read tries again */ });
    const timer = setInterval(read, DETECT_EVERY_MS);
    read();
    return () => { clearInterval(timer); abort.abort(); };
  }, [step.kind, machineId, agent.id]);

  // one request at a time: a second tap while one is unanswered sends nothing
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  // a reply that comes after the card is gone (Skip setup, another pane) changes nothing and opens no tab
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
  const signIn = () => ask(() => startAgentSignIn(agent.id, machineId), (tab) => dispatch({ type: "sign-in-started", tab }));
  return { step, dispatch, pending, install, signIn };
}
