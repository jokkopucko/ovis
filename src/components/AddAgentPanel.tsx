import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { ApiError, fetchAgentCatalog } from "../lib/api.ts";
import { addableAgents } from "../lib/agentList.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { AgentTile } from "./AgentTile.tsx";
import "./AddAgentPanel.css";

export interface AddAgentPanelProps {
  /** the agent is installed now: the picker takes it */
  onReady: (agent: string) => void;
  /** shows the tab an install runs in, which leaves the dialog */
  onOpenTerminal: (paneId: string) => void;
  /** back to the dialog's own fields, with nothing picked */
  onBack: () => void;
}

/**
 * A creation dialog's Add another agent: the agents the PC open in it does not have yet and a picker
 * could start, as the setup guide's tiles. Install is the one tap; the ring turns on the tile until the
 * PC lists the agent, and then the picker takes it. The sign-in is the agent's own, when it first
 * starts. Back keeps what the dialog had.
 */
export function AddAgentPanel({ onReady, onOpenTerminal, onBack }: AddAgentPanelProps) {
  const t = useT();
  const machineId = useMachineId();
  const [agents, setAgents] = useState<AgentCatalogRow[] | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetchAgentCatalog(machineId, abort.signal).then(
      (catalog) => setAgents(addableAgents(catalog.agents)),
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        // a PC on an Ovis from before the catalog answers 404 for it
        setError(reason instanceof ApiError && reason.status === 404 ? { message: t("This PC's Ovis cannot install agents yet. Update it, then try again."), detail: null } : userErrorMessage(reason));
      },
    );
    return () => abort.abort();
  }, [machineId, t]);

  // the focus starts on the first Install, else on Back
  useEffect(() => {
    if (agents === null && error === null) return;
    const install = document.querySelector<HTMLElement>(".add-agent .setup-tile-install");
    (install ?? back.current)?.focus();
  }, [agents, error]);

  const failed = Object.values(failures);
  return (
    <div className="add-agent">
      {error !== null ? (
        <p className="field-hint add-agent-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>
      ) : agents === null ? (
        <p className="field-hint" role="status">{t("Loading…")}</p>
      ) : agents.length === 0 ? (
        <p className="field-hint" role="status">{t("No other agents to install here.")}</p>
      ) : (
        <ul className="setup-found" aria-label={t("Agents you can install")}>
          {agents.map((agent) => (
            <AgentTile key={agent.id} agent={agent} has={false} machineId={machineId} onOpenTerminal={onOpenTerminal}
              onInstalled={onReady}
              onError={(id, message) => setFailures((current) => {
                const { [id]: _gone, ...rest } = current;
                return message === null ? rest : { ...rest, [id]: message };
              })} />
          ))}
        </ul>
      )}
      {failed.length > 0 && <p className="field-hint add-agent-error" role="alert">{failed.join(" ")}</p>}
      <div className="add-agent-actions">
        <button type="button" ref={back} className="btn btn-ghost" onClick={onBack}><ArrowLeft aria-hidden="true" />{t("Back")}</button>
      </div>
    </div>
  );
}
