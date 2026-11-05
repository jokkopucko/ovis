import { useState } from "react";
import { Check, ChevronDown, ChevronUp, KeyRound, LoaderCircle, Play, RotateCw, SquareTerminal, TriangleAlert } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { setupProgress, type SetupStep } from "../lib/agentSetup.ts";
import { useT } from "../lib/i18n.ts";
import { useAgentSetup } from "../lib/useAgentSetup.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./AgentSetupCard.css";

export interface AgentSetupCardProps {
  /** the agent, as GET /api/agent-catalog answered it for `machineId` */
  agent: AgentCatalogRow;
  machineId?: string;
  /** a step to start from (tests, the demo's screenshots); the card moves on from it */
  initial?: SetupStep;
  /** shows the tab an install or sign-in runs in */
  onOpenTerminal: (paneId: string) => void;
  /** the agent is ready: start it */
  onStart: () => void;
  /** told each step the card moves to */
  onStep?: (step: SetupStep) => void;
}

/**
 * One agent's setup in two steps, Install then Sign in, on one card: each step runs the PC's own
 * official command in a terminal tab the user can open, and installed is decided by reading the
 * catalog again, never by how the tab ended.
 */
export function AgentSetupCard({ agent, machineId = "local", initial = { kind: "idle" }, onOpenTerminal, onStart, onStep }: AgentSetupCardProps) {
  const t = useT();
  const { step, dispatch, pending, install, signIn } = useAgentSetup({ agent, machineId, initial, onStep });
  const [details, setDetails] = useState(false);
  const { index, fraction } = setupProgress(step);
  const name = agent.name;
  const tab = step.kind === "installing" || step.kind === "signing-in" ? step.tab : null;
  const command = tab?.command ?? agent.install?.primary.command ?? null;

  return (
    <section className="agent-setup" aria-label={t("Set up {agent}", { agent: name })}>
      <header className="agent-setup-head">
        <AgentMark agent={agent.id} size={36} />
        <div className="agent-setup-title">
          <h2>{name}</h2>
          <p>{agent.description}</p>
        </div>
      </header>
      <ol className="agent-setup-steps">
        {[t("Install"), t("Sign in")].map((label, position) => (
          <li key={label} data-state={step.kind === "failed" && position === index ? "failed" : position < index ? "done" : position === index ? "now" : undefined}>
            <span className="agent-setup-dot" aria-hidden="true">{position < index ? <Check /> : position + 1}</span>{label}
          </li>
        ))}
      </ol>
      <div className="agent-setup-bar" data-state={step.kind} aria-hidden="true"><span style={{ width: `${fraction * 100}%` }} /></div>
      <div className="agent-setup-status" role="status" data-state={step.kind}>
        {step.kind === "idle" && <><SquareTerminal aria-hidden="true" /><div><strong>{t("Install {agent}", { agent: name })}</strong><span>{t("Uses the official installer, on this PC.")}</span></div></>}
        {step.kind === "installing" && <><LoaderCircle className="agent-setup-spin" aria-hidden="true" /><div><strong>{t("Installing {agent}…", { agent: name })}</strong><span>{t("This can take a few minutes. You can keep using Ovis.")}</span></div></>}
        {step.kind === "installed" && <><KeyRound aria-hidden="true" /><div><strong>{t("Sign in to {agent}", { agent: name })}</strong><span>{step.onPath ? t("Installed. Sign in so it can use your plan.") : t("Installed. New terminal tabs will find it.")}</span></div></>}
        {step.kind === "signing-in" && <><LoaderCircle className="agent-setup-spin" aria-hidden="true" /><div><strong>{t("Finish signing in")}</strong><span>{t("Follow the steps in the sign-in tab, then come back here.")}</span></div></>}
        {step.kind === "ready" && <><Check aria-hidden="true" /><div><strong>{t("{agent} is ready", { agent: name })}</strong>{step.version && <span>{t("Version {version}", { version: step.version })}</span>}</div></>}
        {step.kind === "failed" && <><TriangleAlert aria-hidden="true" /><div><strong>{step.message === null ? t("{agent} does not start", { agent: name }) : t("It did not finish")}</strong><span>{step.message ?? t("It is on this PC, but it does not start. Install it again.")}</span></div></>}
      </div>
      {details && command !== null && <pre className="agent-setup-command"><code>{command}</code></pre>}
      {details && step.kind === "installed" && !step.onPath && <p className="agent-setup-note">{t("Its folder is on PATH only for terminals opened after the install.")}</p>}
      <div className="agent-setup-actions">
        {step.kind === "idle" && <button type="button" className="btn btn-primary" disabled={agent.install === null || pending} onClick={install}>{t("Install")}</button>}
        {step.kind === "installed" && <><button type="button" className="btn btn-primary" disabled={pending} onClick={() => signIn()}>{t("Sign in")}</button><button type="button" className="btn btn-ghost" disabled={pending} onClick={() => dispatch({ type: "skip-sign-in" })}>{t("Skip")}</button></>}
        {step.kind === "signing-in" && <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: "sign-in-done" })}>{t("I've signed in")}</button>}
        {step.kind === "ready" && <button type="button" className="btn btn-primary" onClick={onStart}><Play aria-hidden="true" />{t("Start {agent}", { agent: name })}</button>}
        {step.kind === "failed" && <button type="button" className="btn btn-primary" disabled={pending} onClick={step.after === "install" ? install : () => signIn()}><RotateCw aria-hidden="true" />{t("Try again")}</button>}
        {(command !== null || step.kind === "installed") && step.kind !== "ready" && <button type="button" className="btn btn-ghost" aria-expanded={details} onClick={() => setDetails((open) => !open)}>{details ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}{details ? t("Hide details") : t("Show details")}</button>}
        {tab !== null && <button type="button" className="btn btn-ghost" onClick={() => onOpenTerminal(tab.pane_id)}><SquareTerminal aria-hidden="true" />{t("Open terminal")}</button>}
        {(step.kind === "installing" || step.kind === "signing-in" || step.kind === "failed") && <button type="button" className="btn agent-setup-cancel" disabled={pending} onClick={() => dispatch({ type: "cancel" })}>{t("Cancel")}</button>}
      </div>
    </section>
  );
}
