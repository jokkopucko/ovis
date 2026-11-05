/**
 * GET /api/pane/omo-tasks: an OmO pane's background tasks and workflows, or a Claude Code or
 * OpenCode pane's subagents, read through the trackers the server core owns. The dispatcher in index.ts runs the
 * access gate first.
 */
import { type ClaudeSubagentStatus, within } from "./claude-subagents.ts";
import { scanClaudeTasks } from "./claude-task-scan.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { processAlive, type OmoStatus } from "./omo-status.ts";
import { omoRuns, omoTasks } from "./omo-tasks.ts";
import type { OpencodeSubagentStatus } from "./opencode-subagents.ts";

/** The core's own trackers: the route reads them and never makes its own. */
export type TaskTrackers = {
  omo: Pick<OmoStatus, "sessionOf"> & Partial<Pick<OmoStatus, "jobsOf">>;
  claudeAgents: Pick<ClaudeSubagentStatus, "sessionOf" | "ensure">;
  opencodeAgents: Pick<OpencodeSubagentStatus, "sessionOf" | "ensure" | "tasksOf" | "beginRead">;
};

/** The answer for the background tasks route, or null when the path is not it. */
export async function handleTasksRequest(request: Request, url: URL, pathname: string, { omo, claudeAgents, opencodeAgents }: TaskTrackers): Promise<Response | null> {
  if (pathname === "/api/pane/omo-tasks") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    // server_time: the browser's clock can differ from this PC's, and the list says how long tasks ran
    const server_time = new Date().toISOString();
    // a Claude pane's subagents, read from its session's files; nothing for any other pane.
    // Its transcript is found here if the background lookup has not got to it yet
    // (for a second at most: a slow herdr answers with what is known, and the next ask has the rest)
    // An unknown pane costs a fresh herdr lookup too; the client bounds its discovery retries.
    if (omo.sessionOf(paneId) === null && claudeAgents.sessionOf(paneId) === null && opencodeAgents.sessionOf(paneId) === null) {
      await within(1000, (async () => {
        // numbered as it begins: a snapshot read since is newer than what this lookup answers
        const begun = opencodeAgents.beginRead();
        const pane = await paneGet(paneId);
        opencodeAgents.ensure(pane, begun);
        await claudeAgents.ensure(pane);
      })());
    }
    // A pane's list is read while the event loop goes on, and the pane may come to run another session,
    // OmO or Claude Code meanwhile: what it runs is told again after the read, and a list is given only for that
    for (let tries = 0; tries < 3; tries++) {
      const session = omo.sessionOf(paneId);
      if (session !== null) {
        // OmO's task children first, then the commands, monitors and cells its transcript tells of
        const tasks = [...omoTasks(session.cwd, session.sessionId, processAlive), ...(omo.jobsOf?.(paneId) ?? [])];
        const running = tasks.filter((task) => task.status === "running");
        return jsonResponse({ tasks: [...running, ...tasks.filter((task) => task.status !== "running")], runs: omoRuns(session.cwd, session.sessionId), server_time });
      }
      // an OpenCode pane's subagents are its child sessions; of a pane that ran both, the one it runs now
      const opencode = opencodeAgents.sessionOf(paneId);
      if (opencode === null || (!opencode.live && claudeAgents.sessionOf(paneId)?.live === true)) {
        const claude = claudeAgents.sessionOf(paneId);
        if (claude === null) return jsonResponse({ tasks: [], runs: [], server_time });
        const tasks = await scanClaudeTasks(claude, request.signal);
        const current = claudeAgents.sessionOf(paneId);
        const codeNow = opencodeAgents.sessionOf(paneId);
        const same = current !== null && current.path === claude.path && current.live === claude.live
          && current.startedAt === claude.startedAt && current.read === claude.read;
        if (same && omo.sessionOf(paneId) === null && (codeNow === null || (!codeNow.live && current.live))) {
          return jsonResponse({ tasks, runs: [], server_time });
        }
        continue;
      }
      const read = await opencodeAgents.tasksOf(paneId);
      // the session the list is of (the one asked about, when there is no list to give)
      const bound = read?.read ?? opencode;
      const current = opencodeAgents.sessionOf(paneId);
      const same = current !== null && current.path === bound.path && current.session === bound.session && current.live === bound.live;
      if (same && omo.sessionOf(paneId) === null && (current.live || claudeAgents.sessionOf(paneId)?.live !== true)) {
        return jsonResponse({ tasks: read?.tasks ?? [], runs: [], server_time, ...(read !== null && read.unlisted > 0 ? { more_running: read.unlisted } : {}) });
      }
    }
    // a pane that kept moving: nothing is told for sure; the client asks again
    return jsonResponse({ tasks: [], runs: [], server_time });
  }
  return null;
}
