/**
 * One coding agent as a tile, shared by the setup guide, a creation dialog's Add another agent and
 * Settings → Agents: installed (with its version), or missing with its Install, which runs
 * the official installer in a terminal tab while a ring turns on the tile, until the PC lists it.
 */
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
  /** the PC has it (it said so, or it was installed from this screen) */
  has: boolean;
  /** shown as the one picked (the setup guide's Start) */
  picked?: boolean;
  /** no install may start (the guide's first workspace is opening) */
  locked?: boolean;
  machineId: string;
  /** an installed tile is picked by a tap; without this it is only shown */
  onPick?: (agent: string) => void;
  onOpenTerminal: (paneId: string) => void;
  /** its install runs (an unanswered request included), or no longer does */
  onRunning?: (agent: string, running: boolean) => void;
  /** an install started from this tile finished: the PC has it now */
  onInstalled: (agent: string) => void;
  /** why its install did not finish; null once it runs again or is done */
  onError?: (agent: string, message: string | null) => void;
}

/**
 * One coding agent. Installed: picked by a tap. Missing: its Install is the one tap (the user's
 * consent): the official installer runs in a terminal tab (a tap on the turning ring shows it) until
 * the catalog lists the agent, then the tile is an installed one. The tile keeps its setup hook
 * through that change, so an install the catalog found first still ends here. The sign-in is the
 * agent's own, when it first starts.
 */
export function AgentTile({ agent, has, picked = false, locked = false, machineId, onPick, onOpenTerminal, onRunning, onInstalled, onError }: AgentTileProps) {
  const t = useT();
  const started = useRef(false);
  // the guide's rule for installed is the catalog's (installed: true), the card's is that the agent
  // runs: a row the install's reads find installed ends the install here as any other read would
  // its watch ends there too: the tile is an installed one from now on
  const stop = useRef<() => void>(() => {});
  const { step, pending, install, dispatch } = useAgentSetup({ agent, machineId, onRow: (row) => { if (row.state.installed === true && started.current) { onInstalled(agent.id); stop.current(); } } });
  stop.current = () => dispatch({ type: "cancel" });
  // a ring that has turned for INSTALL_GIVE_UP_MS without the PC listing the agent stops, to be tried
  // again; it counts from the tap, the request still unanswered included
  const [overdue, setOverdue] = useState(false);
  // each tap is an attempt of its own: its deadline starts again
  const [attempt, setAttempt] = useState(0);
  const turning = pending || step.kind === "installing";
  useEffect(() => {
    setOverdue(false);
    if (!turning) return;
    const timer = window.setTimeout(() => setOverdue(true), INSTALL_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [turning, attempt]);
  const state = tileState(has, step, pending, overdue ? INSTALL_GIVE_UP_MS : 0);
  // an unanswered request counts as running even past the deadline: Look again would end its watch
  const running = state === "installing" || pending;
  useEffect(() => { onRunning?.(agent.id, running); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onRunning?.(agent.id, false), []); // eslint-disable-line react-hooks/exhaustive-deps
  // its own news only: an error while it failed or stuck, nothing otherwise
  const reason = state === "failed" && step.kind === "failed" ? step.message ?? t("It is on this PC, but it does not start. Install it again.") : state === "stuck" ? t("It took too long. Try again.") : null;
  useEffect(() => { onError?.(agent.id, reason === null ? null : t("{agent} did not install. {reason}", { agent: agent.name, reason })); }, [reason]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onError?.(agent.id, null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // the button that had the focus went with the install: the installed tile takes it
  const tile = useRef<HTMLLIElement>(null);
  const focused = useRef(false);
  // however it learned so (its own read, another agent's), an installed tile watches no install, a
  // late answer to its request included
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
  return (
    <li ref={tile} onFocus={() => { focused.current = true; }} onBlur={(event) => { if (event.relatedTarget !== null) focused.current = false; }}>
      {state === "installed" ? (onPick === undefined ? (
        <div className="setup-tile" data-agent={agent.id}>
          <AgentMark agent={agent.id} size={20} />
          <span className="setup-found-name"><strong>{agent.name}</strong>{agent.state.version !== null && <span>{agent.state.version}</span>}</span>
        </div>
      ) : (
        <button type="button" className="setup-tile" data-agent={agent.id} aria-pressed={picked} disabled={locked} onClick={() => onPick(agent.id)}>
          <AgentMark agent={agent.id} size={20} />
          <span className="setup-found-name"><strong>{agent.name}</strong>{agent.state.version !== null && <span>{agent.state.version}</span>}</span>
          {picked && <Check aria-hidden="true" />}
        </button>
      )) : (
        <div className="setup-tile" data-agent={agent.id} data-missing="" data-state={state} aria-busy={state === "installing" || undefined}>
          <AgentMark agent={agent.id} size={20} />
          <span className="setup-found-name"><strong>{agent.name}</strong></span>
          {(state !== "missing" || (agent.state.installed !== null && agent.install !== null)) && (
            // one button through every state, so the focus stays on it: Install, the turning ring (its tab
            // once there is one), Try again
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
