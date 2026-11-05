/** The agents whose own stores GET /api/sessions/history reads. */
export type SessionHistoryAgent = "claude" | "codex" | "pi" | "omp" | "gjc" | "cmd" | "omo" | "opencode" | "hermes" | "grok" | "agy" | "devin";

/**
 * Where a Claude row was listed from: the pane whose Claude's store was read, and that store's key
 * (a hash: no path). Resume sends both back (SessionResumeRequest).
 */
export interface SessionResumeSource {
  pane_id: string;
  store_key: string;
}

/**
 * One earlier session. `resume.argv` is the agent kind and its arguments; null where its syntax is
 * not verified. A Claude row carries `resume.source` from a bridge that binds its Resume to the
 * store it was listed from; without it a Claude row offers no Resume.
 */
export interface SessionHistoryRow {
  id: string;
  title: string | null;
  /** prompt text: only for a connection that may drive */
  firstMessage: string | null;
  startedAt: string | null;
  updatedAt: string;
  resume: { argv: string[]; source?: SessionResumeSource } | null;
}

/** POST /api/sessions/resume: a Claude row's Resume, with the source its listing gave. */
export interface SessionResumeRequest {
  workspace_id: string;
  pane_id: string;
  agent: "claude";
  session_id: string;
  store_key: string;
}

/** The workspace's pane already showing the session on the same store, or the new tab the session was started in. */
export type SessionResumeResponse =
  | { action: "opened"; workspace_id: string; pane_id: string }
  | { action: "created"; workspace_id: string; pane_id: string; agent_started: boolean; error?: { code: string; message: string } };

/**
 * Pi establishes all rows with bounded header reads before scanning labels. A label deadline keeps
 * every established row, with null unfinished labels or unchanged cached labels, even on label read
 * failures or file changes. Later listings resume unchanged files and unfinished headers. Header
 * expiry/failure with no checked rows, a full header queue or reader shutdown answers 503
 * `session_history_busy` with Retry-After: 1. Both responses carry Cache-Control: no-store.
 */
export interface SessionHistoryResponse {
  workspace_id: string;
  agent: SessionHistoryAgent;
  cwd: string;
  /** newest first, at most 50 */
  sessions: SessionHistoryRow[];
}
