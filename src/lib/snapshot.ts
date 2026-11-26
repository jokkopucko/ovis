import type { AgentStatus, HerdrPane, PaneContext, PlanSummary, SessionSnapshot } from "../../shared/protocol.ts";

const samePlan = (a: PlanSummary | undefined, b: PlanSummary | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.done === b.done && a.total === b.total && a.current === b.current);

export function applyPaneStatus(snapshot: SessionSnapshot, paneId: string, status: AgentStatus, background?: number, waiting = false, plan?: PlanSummary | null, finishId?: number, finishEpoch?: string, context?: PaneContext | null): SessionSnapshot {
  const epochChanged = snapshot.finish_epoch !== finishEpoch;
  let paneChanged = epochChanged;
  const panes = snapshot.panes.map((pane: HerdrPane) => {
    if (pane.pane_id !== paneId) {
      if (!epochChanged) return pane;
      const { finish_id: _finish, ...rest } = pane;
      return rest;
    }
    const tasks = background === undefined ? pane.background_tasks : background > 0 ? background : undefined;
    const progress = plan === undefined ? pane.plan : plan ?? undefined;
    const filled = context === undefined ? pane.context : context ?? undefined;
    if (pane.agent_status === status && pane.finish_id === finishId && pane.background_tasks === tasks && (pane.background_wait === true) === waiting && samePlan(pane.plan, progress) && pane.context?.used === filled?.used && pane.context?.window === filled?.window) return pane;
    paneChanged = true;
    const { background_tasks: _before, background_wait: _waited, plan: _plan, context: _context, finish_id: _finish, copilot_processing: processing, ...rest } = pane;
    const started = status === "working" && pane.agent_status !== "working";
    const sample = started && processing === false ? undefined : processing;
    return { ...rest, agent_status: status, ...(sample === undefined ? {} : { copilot_processing: sample }), ...(finishId === undefined ? {} : { finish_id: finishId }), ...(tasks === undefined ? {} : { background_tasks: tasks }), ...(waiting ? { background_wait: true as const } : {}), ...(progress === undefined ? {} : { plan: progress }), ...(filled === undefined ? {} : { context: filled }) };
  });
  if (!paneChanged) return snapshot;
  const agents = snapshot.agents.map((agent) =>
    agent.pane_id === paneId && agent.agent_status !== status ? { ...agent, agent_status: status } : agent,
  );
  return { ...snapshot, finish_epoch: finishEpoch, panes, agents };
}
