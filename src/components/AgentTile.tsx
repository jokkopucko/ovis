import { useEffect, useRef, useState } from "react";
import { Check, Download, LoaderCircle, RotateCw } from "lucide-react";

import type { AgentCatalogRow } from "../../shared/agent-catalog.ts";
import { useT } from "../lib/i18n.ts";
import { INSTALL_GIVE_UP_MS, tileState } from "../lib/setupGuideFlow.ts";
import { useAgentSetup } from "../lib/useAgentSetup.ts";
import { AgentMark } from "./AgentMark.tsx";
import "./AgentTile.css";

export interface AgentTileProps {
  agent: AgentCatalogRow;
  has: boolean;
  picked?: boolean;
  locked?: boolean;
  machineId: string;
  onPick?: (agent: string) => void;
  onOpenTerminal: (paneId: string) => void;
  onRunning?: (agent: string, running: boolean) => void;
  onInstalled: (agent: string) => void;
  onError?: (agent: string, message: string | null) => void;
}

/**
 * Missing: its Install is the one tap (the user's consent): the official installer runs in a terminal tab (a tap on
 * the turning ring shows it) until the catalog lists the agent, then the tile is an installed one.
 */
export function AgentTile({ agent, has, picked = false, locked = false, machineId, onPick, onOpenTerminal, onRunning, onInstalled, onError }: AgentTileProps) {
  const t = useT();
  const started = useRef(false);
  const stop = useRef<() => void>(() => {});
  const { step, pending, install, dispatch } = useAgentSetup({ agent, machineId, onRow: (row) => { if (row.state.installed === true && started.current) { onInstalled(agent.id); stop.current(); } } });
  stop.current = () => dispatch({ type: "cancel" });
  const [overdue, setOverdue] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const turning = pending || step.kind === "installing";
  useEffect(() => {
    setOverdue(false);
    if (!turning) return;
    const timer = window.setTimeout(() => setOverdue(true), INSTALL_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [turning, attempt]);
  const state = tileState(has, step, pending, overdue ? INSTALL_GIVE_UP_MS : 0);
  const running = state === "installing" || pending;
  useEffect(() => { onRunning?.(agent.id, running); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onRunning?.(agent.id, false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const reason = state === "failed" && step.kind === "failed" ? step.message ?? t("It is on this PC, but it does not start. Install it again.") : state === "stuck" ? t("It took too long. Try again.") : null;
  useEffect(() => { onError?.(agent.id, reason === null ? null : t("{agent} did not install. {reason}", { agent: agent.name, reason })); }, [reason]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onError?.(agent.id, null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const tile = useRef<HTMLLIElement>(null);
  const focused = useRef(false);
  useEffect(() => { if (state === "installed" && step.kind === "installing") stop.current(); }, [state, step.kind]);
  useEffect(() => {
    if (state !== "installed") return;
    if (!started.current) return;
    started.current = false;
    onInstalled(agent.id);
    if (focused.current && (document.activeElement === null || document.activeElement === document.body)) tile.current?.querySelector<HTMLElement>("button")?.focus();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const tap = (): void => {
    // the first request still unanswered: it may have started the installer, so no second one yet
    if (pending) return;
    started.current = true;
    setAttempt((count) => count + 1);
    if (step.kind === "installing") dispatch({ type: "cancel" });
    install();
  };
  const tab = step.kind === "installing" ? step.tab : null;
  const missingNote = state === "missing" && agent.state.installed === null ? t("Cannot check") : state === "missing" && agent.install === null ? t("Manual install") : null;
  return (
    <li ref={tile} onFocus={() => { focused.current = true; }} onBlur={(event) => { if (event.relatedTarget !== null) focused.current = false; }}>
      {state === "installed" ? (onPick === undefined ? (
        <div className="setup-tile" data-agent={agent.id}>
          <AgentMark agent={agent.id} size={20} />
          <span className="setup-found-name" title={agent.name}><strong>{agent.name}</strong>{agent.state.version !== null && <span>{agent.state.version}</span>}</span>
        </div>
      ) : (
        <button type="button" className="setup-tile" data-agent={agent.id} aria-pressed={picked} disabled={locked} onClick={() => onPick(agent.id)}>
          <AgentMark agent={agent.id} size={20} />
          <span className="setup-found-name" title={agent.name}><strong>{agent.name}</strong>{agent.state.version !== null && <span>{agent.state.version}</span>}</span>
          {picked && <Check aria-hidden="true" />}
        </button>
      )) : (
        <div className="setup-tile" data-agent={agent.id} data-missing="" data-state={state} aria-busy={state === "installing" || undefined}>
          <AgentMark agent={agent.id} size={20} />
          <span className="setup-found-name" title={missingNote === null ? agent.name : agent.no_install ?? agent.name}><strong>{agent.name}</strong>{missingNote !== null && <span>{missingNote}</span>}</span>
          {(state !== "missing" || (agent.state.installed !== null && agent.install !== null)) && (
            <button type="button" className="btn setup-tile-install"
              aria-disabled={(state === "installing" && tab === null) || (state !== "installing" && pending) ? true : undefined}
              disabled={state !== "installing" && locked}
              aria-label={state === "installing" ? (tab === null ? t("Installing {agent}…", { agent: agent.name }) : t("Installing {agent}… Open terminal", { agent: agent.name })) : state === "missing" ? t("Install {agent}", { agent: agent.name }) : t("Try installing {agent} again", { agent: agent.name })}
              onClick={() => { if (state === "installing") { if (tab !== null) onOpenTerminal(tab.pane_id); return; } tap(); }}>
              {state === "installing" ? <LoaderCircle aria-hidden="true" className="setup-spin" /> : state === "missing" ? <Download aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
              {state !== "installing" && <span className="setup-tile-install-label">{state === "missing" ? t("Install") : t("Try again")}</span>}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
