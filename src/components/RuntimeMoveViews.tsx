/**
 * What the move dialog (RuntimeMove.tsx) shows in each state: the plan as a workspace > tab > pane
 * tree with a tag per pane, the panes holding a move up, the steps of a move under way, and a
 * rollback's result. Read-only: every action stays in the dialog's footer.
 */
import { Check } from "lucide-react";

import type { MovePane, MovePlan, MoveStatus } from "../../shared/runtime-move.ts";
import type { Translate } from "../lib/i18n.ts";
import { agentName, blockingPanes, moveReasonText, moveStepText, moveWhyText, paneTitle, tabPaneIds, verdictTag } from "../lib/runtimeMove.ts";

const STEPS = ["ending_agents", "building", "starting_agents", "switching"] as const;

function PaneLine({ t, pane }: { t: Translate; pane: MovePane }) {
  const tag = verdictTag(t, pane.verdict);
  return (
    <>
      <span className="runtime-move-pane-text">
        <span className="runtime-move-pane-name">{paneTitle(t, pane)}</span>
        {pane.cwd !== null && <span className="runtime-move-cwd">{pane.cwd}</span>}
      </span>
      <span className="runtime-move-tag" data-tone={tag.tone}>{tag.text}</span>
    </>
  );
}

export function PlanView({ t, plan, leadId }: { t: Translate; plan: MovePlan; leadId: string }) {
  const byId = new Map(plan.panes.map((pane) => [pane.pane_id, pane]));
  return (
    <>
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
      <p className="runtime-move-note" id={leadId}>{t("Scrollback and programs running in shells do not come along. herdr itself stays as it is.")}</p>
    </>
  );
}

export function WaitingView({ t, plan, leadId }: { t: Translate; plan: MovePlan; leadId: string }) {
  const held = blockingPanes(plan);
  return (
    <>
      <p className="runtime-move-lead" id={leadId} role="status">{held.length === 1 ? t("One pane is at work. Everything moves at once when it is done.") : t("{n} panes are at work. Everything moves at once when they are done.", { n: held.length })}</p>
      <ul className="runtime-move-list">
        {held.map((pane) => <li key={pane.pane_id} className="runtime-move-pane"><PaneLine t={t} pane={pane} /></li>)}
      </ul>
      <p className="runtime-move-note">{t("End a program in a shell (Ctrl+C) or an agent marked above yourself; the move then goes on by itself.")}</p>
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
