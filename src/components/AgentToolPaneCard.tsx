import { useState } from "react";
import { Network } from "lucide-react";

import { answerAgentToolPane } from "../lib/api.ts";
import { useAgentToolPanes } from "../lib/agentToolPanes.ts";
import { useT } from "../lib/i18n.ts";
import "./AgentToolPaneCard.css";

/**
 * A pane hc started asks this PC's owner, once, for the tool to call other agents (docs/harness-tool.md). One card at a
 * time, the oldest first; the first window to answer clears it in every other. It never takes the focus, so a key
 * meant for the terminal cannot press Allow.
 */
export function AgentToolPaneCard() {
  const t = useT();
  const { pending } = useAgentToolPanes();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const pane = pending[0];
  if (!pane) return null;
  const decide = (decision: "allow" | "deny") => {
    setBusy(pane.id);
    setFailed(null);
    answerAgentToolPane(pane.id, decision).catch(() => setFailed(pane.id)).finally(() => setBusy(null));
  };
  const name = pane.label === pane.pane ? pane.pane : `${pane.label} (${pane.pane})`;
  return (
    // keyed by the card: a button focused on one pane's card is gone when another pane's card takes its place
    <div className="relay-pairing-layer" key={pane.id}>
      <div className="update-notice is-paired relay-pairing-prompt" role="group" aria-label={t("Give {name} the tool to call other agents?", { name })} data-testid="agent-tool-pane-card">
        <Network aria-hidden="true" />
        <span>
          <strong>{t("Give {name} the tool to call other agents?", { name })}</strong>
          <span className="agent-tool-pane-note">{t("Programs in this pane can start other agents and give them work until it closes. You still answer every permission request.")}</span>
          {failed === pane.id && <span className="relay-error" role="alert"> {t("Not saved: this PC did not answer. Try again.")}</span>}
        </span>
        <div className="device-paired-actions">
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => decide("allow")}>{t("Allow")}</button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => decide("deny")}>{t("Deny")}</button>
        </div>
      </div>
    </div>
  );
}
