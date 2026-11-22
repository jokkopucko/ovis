/**
 * GET /api/pane/plan: the plan the pane's agent keeps now (Claude Code's task list, Codex's
 * `update_plan` checklist, OmO's `todo` list), read through the trackers the server core owns. The
 * dispatcher in index.ts runs the access gate first.
 */
import type { HerdrPane } from "../shared/protocol.ts";
import type { PanePlan } from "../shared/plans.ts";
import { type ClaudeSubagentStatus, within } from "./claude-subagents.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import type { OmoStatus } from "./omo-status.ts";
import type { SessionPlans } from "./session-plan.ts";

export type PlanTrackers = { omo: Pick<OmoStatus, "apply">; claudeAgents: Pick<ClaudeSubagentStatus, "ensure">; plans: Pick<SessionPlans, "known" | "ensure" | "planOf"> };

export async function handlePlanRequest(request: Request, url: URL, pathname: string, { omo, claudeAgents, plans }: PlanTrackers): Promise<Response | null> {
  if (pathname === "/api/pane/plan") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    // Herdr may name an OmO pane `claude`: use its resolved identity before looking up a plan.
    const seen: { pane?: HerdrPane } = {};
    await within(1000, (async () => {
      const pane = seen.pane = omo.apply(await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
      if (pane === undefined || plans.known(pane)) return;
      if (pane.agent === "claude") await claudeAgents.ensure(pane);
      await plans.ensure(pane, true);
    })());
    const steps = plans.planOf(seen.pane);
    const answer: PanePlan = { plan: steps === null ? null : { steps }, server_time: new Date().toISOString() };
    return jsonResponse(answer);
  }
  return null;
}
