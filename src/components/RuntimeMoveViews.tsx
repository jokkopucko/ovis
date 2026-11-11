/**
 * What the move dialog (RuntimeMove.tsx) shows in each state: the plan as a workspace > tab > pane
 * tree with a tag per pane, the panes holding a move up, the steps of a move under way, and a
 * rollback's result. The wait's rows carry their own pane's action (end its command, open an agent);
 * every other action stays in the dialog's footer.
 */
import type { ReactNode } from "react";
import { Check } from "lucide-react";

import type { MovePane, MovePlan, MoveStatus, MoveStopAllOffer, MoveStopping } from "../../shared/runtime-move.ts";
import type { Translate } from "../lib/i18n.ts";
import { agentName, blockingPanes, moveReasonText, moveStepText, moveWhyText, paneAgent, paneTitle, tabPaneIds, verdictTag } from "../lib/runtimeMove.ts";

const STEPS = ["ending_agents", "building", "starting_agents", "switching"] as const;

function PaneLine({ t, pane, action }: { t: Translate; pane: MovePane; action?: ReactNode }) {
  const tag = verdictTag(t, pane.verdict);
  return (
    <>
      <span className="runtime-move-pane-text">
        <span className="runtime-move-pane-name">{paneTitle(t, pane)}</span>
        {pane.cwd !== null && <span className="runtime-move-cwd">{pane.cwd}</span>}
      </span>
      <span className="runtime-move-tag" data-tone={tag.tone}>{tag.text}</span>
      {action}
    </>
  );
}

interface WaitActions {
  stopping: readonly MoveStopping[];
  pending: boolean;
  onStop: (pane: MovePane, force: boolean) => void;
  /** null: this page cannot open a pane (no app around the dialog) */
  onOpenPane: ((paneId: string) => void) | null;
}

/**
 * A shell's command: End sends it Ctrl+C; while it still runs, Ending… until the server offers Force end.
 * An agent is never ended from here: its pane opens, and the person ends it there.
 */
function PaneAction({ t, pane, stopping, pending, onStop, onOpenPane }: WaitActions & { t: Translate; pane: MovePane }) {
  const { verdict } = pane;
  if (verdict.kind === "busy" && verdict.reason === "command_running") {
    const tried = stopping.find((entry) => entry.pane_id === pane.pane_id);
    if (tried?.force) return <button type="button" className="btn btn-danger" disabled={pending} onClick={() => onStop(pane, true)}>{t("Force end")}</button>;
    if (tried) return <button type="button" className="btn" disabled>{t("Ending…")}</button>;
    return <button type="button" className="btn" disabled={pending} onClick={() => onStop(pane, false)}>{t("End")}</button>;
  }
  if (paneAgent(pane) === null || onOpenPane === null) return null;
  return <button type="button" className="btn" onClick={() => onOpenPane(pane.pane_id)}>{t("Open the agent's pane")}</button>;
}

export function PlanView({ t, plan, leadId }: { t: Translate; plan: MovePlan; leadId: string }) {
  const byId = new Map(plan.panes.map((pane) => [pane.pane_id, pane]));
  return (
    <>
      {/* what does not move, read before the list and the Move button (G-104) */}
      <p className="runtime-move-note" id={leadId}>{t("Scrollback and programs running in shells do not come along. herdr itself stays as it is.")} {t("Each pane opens a new shell from your login profile: variables set by hand in a pane stay behind.")}</p>
      <ul className="runtime-move-tree">
        {plan.workspaces.map((workspace) => (
          <li key={workspace.workspace_id}>
            <span className="runtime-move-workspace">{workspace.name}</span>
            <ul>
              {workspace.tabs.map((tab) => (
                <li key={tab.tab_id}>
                  <span className="runtime-move-tab">{tab.name}</span>
                  <ul>
                    {tabPaneIds(tab.root).flatMap((paneId) => { const pane = byId.get(paneId); return pane ? [<li key={paneId} className="runtime-move-pane"><PaneLine t={t} pane={pane} /></li>] : []; })}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

export function WaitingView({ t, plan, leadId, confirming, ...actions }: WaitActions & { t: Translate; plan: MovePlan; leadId: string; confirming: MoveStopAllOffer["panes"] | null }) {
  const held = blockingPanes(plan);
  return (
    <>
      <p className="runtime-move-lead" id={leadId} role="status">{held.length === 1 ? t("One pane is at work. Everything moves at once when it is done.") : t("{n} panes are at work. Everything moves at once when they are done.", { n: held.length })}</p>
      <ul className="runtime-move-list">
        {held.map((pane) => <li key={pane.pane_id} className="runtime-move-pane"><PaneLine t={t} pane={pane} action={<PaneAction t={t} pane={pane} {...actions} />} /></li>)}
      </ul>
      {confirming === null
        ? <p className="runtime-move-note">{t("End an agent marked above yourself; the move goes on by itself once nothing runs.")}</p>
        : <div className="runtime-move-confirm" role="alert">
            {confirming.length === 1 ? t("Ends 1 running command. Unsaved work may be lost.") : t("Ends {n} running commands. Unsaved work may be lost.", { n: confirming.length })}
            {/* each pane the server's token covers, which may differ from the last poll's rows: its command and where */}
            <ul className="runtime-move-confirm-list">
              {confirming.map((covered) => {
                const pane = plan.panes.find((entry) => entry.pane_id === covered.pane_id);
                const where = pane?.name ?? pane?.cwd ?? null;
                return <li key={covered.pane_id}>{where === null ? covered.command : `${covered.command} · ${where}`}</li>;
              })}
            </ul>
          </div>}
    </>
  );
}

export function MovingView({ t, status, leadId }: { t: Translate; status: Extract<MoveStatus, { state: "moving" }>; leadId: string }) {
  const at = STEPS.indexOf(status.step);
  return (
    <ol className="runtime-move-steps" id={leadId} aria-live="polite">
      {STEPS.map((step, index) => (
        <li key={step} data-state={index < at ? "done" : index === at ? "now" : "later"}>
          <span className="runtime-move-mark" aria-hidden="true">{index < at && <Check />}</span>
          <span>{moveStepText(t, step)}</span>
          {index === at && <span className="runtime-move-count">{status.done}/{status.total}</span>}
        </li>
      ))}
    </ol>
  );
}

export function ResultView({ t, plan, status, leadId }: { t: Translate; plan: MovePlan; status: Extract<MoveStatus, { state: "rolled_back" | "interrupted" }>; leadId: string }) {
  const byId = new Map(plan.panes.map((pane) => [pane.pane_id, pane]));
  return (
    <>
      {status.state === "rolled_back" && <p className="runtime-move-lead" id={leadId} role="status">{t("Could not move. Ovis put back what it could; anything it could not is listed below.")}</p>}
      <p className="runtime-move-reason" {...(status.state === "interrupted" ? { id: leadId, role: "status" } : {})}>{moveReasonText(t, status.reason)}</p>
      {status.left.length > 0 && (
        <>
          <p className="runtime-move-note">{t("Not reopened in herdr:")}</p>
          <ul className="runtime-move-list">
            {status.left.map((item) => {
              const pane = byId.get(item.pane_id);
              return (
                <li key={item.pane_id} className="runtime-move-pane">
                  <span className="runtime-move-pane-text">
                    <span className="runtime-move-pane-name">{pane ? paneTitle(t, pane) : agentName(item.agent)}</span>
                    <span className="runtime-move-why">{moveWhyText(t, item.why)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
