/**
 * Earlier sessions of a workspace's folder, as GET /api/sessions/history lists them (#1314), and
 * what the client does with a row: Resume starts the row's own argv as the agent of a new tab in
 * the workspace, unless a pane of the workspace already shows that session, which is then
 * selected in the browser instead (never focused in herdr). A session is known to be shown by
 * the pane's `agent_session`, which herdr reports as the session's id or its file, or, until herdr
 * reports it, by the record of a Resume a moment ago (RecentResume, kept by App across the dialog's
 * openings): the dialog's own in-flight guard ends with the dialog, and a list reopened before
 * herdr has looked at the new pane would otherwise start a second agent on the same session.
 *
 * Claude keeps one store per CLAUDE_CONFIG_DIR, and two stores can hold the same session id: a Claude
 * row is the session in the store its list was read from (`resume.source`), and is resumed through
 * POST /api/sessions/resume, which starts it in that store or answers with the pane already showing
 * it there. A pane reporting the same id is that row's only when it is the source pane itself;
 * another may be on another store. A Claude row without a source offers no Resume.
 */
import type { CreateTabRequest, HerdrPane, SessionHistoryAgent, SessionHistoryRow, SessionResumeRequest } from "../../shared/protocol.ts";
import { formatChatTimestamp } from "./chatTimestamp.ts";
import type { Translate } from "./i18n.ts";

export const SESSION_HISTORY_AGENTS: readonly SessionHistoryAgent[] = ["claude", "codex", "pi", "omp", "gjc", "cmd", "omo", "opencode", "hermes", "grok", "agy", "devin"];

/**
 * A pane's request (its chat's /resume) lists that pane's
 * own agent or nothing: a Copilot chat never gets Claude's sessions, whose Resume would start another
 * agent.
 */
export function sessionHistoryListAgent(request: { agent?: string | null; scope?: "pane" | "workspace" } | undefined, front: string | null | undefined, workspaceAgents: readonly (string | null | undefined)[]): SessionHistoryAgent | null {
  const named = sessionHistoryAgent(request?.agent);
  if (request?.scope === "pane") return named;
  return named ?? sessionHistoryAgent(front) ?? workspaceAgents.map((agent) => sessionHistoryAgent(agent)).find((kind) => kind !== null) ?? "claude";
}

export function sessionHistoryAgent(agent: string | null | undefined): SessionHistoryAgent | null {
  return agent && (SESSION_HISTORY_AGENTS as readonly string[]).includes(agent) ? (agent as SessionHistoryAgent) : null;
}

export function sessionHistorySourcePane(agent: SessionHistoryAgent, panes: readonly HerdrPane[], request: { readonly workspaceId: string; readonly askingPaneId?: string | null; readonly selectedPaneId?: string | null }): string | null {
  const workspacePanes = panes.filter((pane) => pane.workspace_id === request.workspaceId);
  const asking = workspacePanes.find((pane) => pane.pane_id === request.askingPaneId);
  const selected = workspacePanes.find((pane) => pane.pane_id === request.selectedPaneId);
  const candidates = [asking, selected, ...workspacePanes];
  const claude = agent === "claude" ? candidates.find((pane) => pane !== undefined && sessionHistoryAgent(pane.agent) === "claude") : undefined;
  return (claude ?? asking ?? selected ?? workspacePanes[0])?.pane_id ?? null;
}

/**
 * A session file's name says the session: Claude names the file by the id, Codex ends the rollout
 * name with it, pi's family puts it after the start time and an underscore.
 */
function fileNamesSession(path: string, id: string): boolean {
  const stem = (path.split(/[/\\]/).pop() ?? "").replace(/\.[^.]+$/, "");
  if (stem === id) return true;
  if (!stem.endsWith(id)) return false;
  return /[-_.]/.test(stem[stem.length - id.length - 1] ?? "");
}

export function paneShowingSession(panes: readonly HerdrPane[], workspaceId: string, agent: SessionHistoryAgent, id: string): HerdrPane | undefined {
  if (id === "") return undefined;
  return panes.find((pane) => {
    const session = pane.agent_session;
    if (pane.workspace_id !== workspaceId || !session || session.agent !== agent || typeof session.value !== "string" || session.value === "") return false;
    return session.kind === "id" ? session.value === id : session.kind === "path" && fileNamesSession(session.value, id);
  });
}

/**
 * The pane of the workspace that shows the row's session. For Claude only the source pane counts:
 * the same id in another pane may be another store's session (the server decides those on Resume).
 */
export function paneShowingRow(panes: readonly HerdrPane[], workspaceId: string, agent: SessionHistoryAgent, row: SessionHistoryRow): HerdrPane | undefined {
  if (agent !== "claude") return paneShowingSession(panes, workspaceId, agent, row.id);
  const source = row.resume?.source;
  return source === undefined ? undefined : paneShowingSession(panes.filter((pane) => pane.pane_id === source.pane_id), workspaceId, agent, row.id);
}

export const rowStore = (row: SessionHistoryRow): string => row.resume?.source?.store_key ?? "";
export const rowKey = (row: SessionHistoryRow): string => `${rowStore(row)}:${row.id}`;

export function claudeResumeRequest(row: SessionHistoryRow, workspaceId: string): SessionResumeRequest | null {
  const source = row.resume?.source;
  if (row.resume?.argv[0] !== "claude" || source === undefined || source.pane_id === "" || source.store_key === "") return null;
  return { workspace_id: workspaceId, pane_id: source.pane_id, agent: "claude", session_id: row.id, store_key: source.store_key };
}

export interface RecentResume {
  machineId: string;
  workspaceId: string;
  agent: SessionHistoryAgent;
  id: string;
  store?: string;
  paneId: string;
  at: number;
  seen: boolean;
  /**
   * the roster has shown the pane running the resumed agent since: only after that does another agent
   * in it, or none, mean the agent stopped (while it starts the pane has no agent yet, and an omo pane
   * shows as pi or claude for a moment)
   */
  ran?: boolean;
}
export const RECENT_RESUME_MS = 2 * 60_000;
/**
 * A pane still listed without a session keeps it however long ago the Resume was: time alone never
 * brings Resume back for a pane that is there.
 */
export function recentResumeEnded(record: RecentResume, panes: readonly HerdrPane[] | undefined, now: number): boolean {
  if (panes === undefined) return false;
  const pane = panes.find((candidate) => candidate.pane_id === record.paneId);
  if (pane !== undefined && record.ran === true && sessionHistoryAgent(pane.agent) !== record.agent) return true;
  if (pane !== undefined) return pane.agent_session !== null && pane.agent_session !== undefined;
  if (record.seen) return true;
  return now - record.at > RECENT_RESUME_MS;
}
export function observeRecentResume(record: RecentResume, panes: readonly HerdrPane[] | undefined): RecentResume {
  const pane = panes?.find((candidate) => candidate.pane_id === record.paneId);
  if (pane === undefined) return record;
  const ran = record.ran === true || sessionHistoryAgent(pane.agent) === record.agent;
  return record.seen && record.ran === ran ? record : { ...record, seen: true, ran };
}
export function standingResume(records: readonly RecentResume[], panes: readonly HerdrPane[] | undefined, machineId: string, workspaceId: string, agent: SessionHistoryAgent, id: string, now: number, store = ""): RecentResume | undefined {
  return records.find((record) => record.machineId === machineId && record.workspaceId === workspaceId && record.agent === agent && record.id === id && (record.store ?? "") === store && !recentResumeEnded(record, panes, now));
}
export function recentlyResumedPane(records: readonly RecentResume[], panes: readonly HerdrPane[], machineId: string, workspaceId: string, agent: SessionHistoryAgent, id: string, now: number, store = ""): HerdrPane | undefined {
  const record = standingResume(records, panes, machineId, workspaceId, agent, id, now, store);
  return record === undefined ? undefined : panes.find((pane) => pane.pane_id === record.paneId && pane.workspace_id === workspaceId);
}
export function sessionRowTime(row: Pick<SessionHistoryRow, "startedAt" | "updatedAt">, now: number, locale: string, t: Translate): { label: string; title: string } | null {
  const updated = formatChatTimestamp(row.updatedAt, now, locale, t);
  if (updated === null) return null;
  const started = formatChatTimestamp(row.startedAt, now, locale, t);
  return { label: updated.label, title: started === null ? updated.full : t("Started {started} · last active {updated}", { started: started.full, updated: updated.full }) };
}

/**
 * POST /api/tab/create for the row: its argv's first word is the agent kind, the rest its arguments;
 * null without a verified resume, and for Claude, whose Resume is bound to its store (claudeResumeRequest).
 */
export function resumeTabRequest(row: SessionHistoryRow, workspaceId: string, cwd: string | null): CreateTabRequest | null {
  const [kind, ...args] = row.resume?.argv ?? [];
  if (!kind || kind === "claude") return null;
  return { workspace_id: workspaceId, cwd, label: null, agent: { kind, args } };
}

/** One task at a time: `run` refuses (null) while an earlier task has not settled, so a double click starts one agent. */
export function inFlightGuard(): { busy: () => boolean; run: <T>(task: () => Promise<T>) => Promise<T> | null } {
  let inFlight: Promise<unknown> | null = null;
  return {
    busy: () => inFlight !== null,
    run: <T>(task: () => Promise<T>): Promise<T> | null => {
      if (inFlight !== null) return null;
      const started = task().finally(() => { if (inFlight === started) inFlight = null; });
      inFlight = started;
      return started;
    },
  };
}
