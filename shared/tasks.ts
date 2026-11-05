/** One background task of an OmO session, one subagent of a Claude Code session, or one subagent or background command of an OpenCode session (GET /api/pane/omo-tasks), from OmO's task record, the subagent's files, or OpenCode's store. */
export interface OmoTask {
  id: string;
  /** the task's summary, else its description or name */
  title: string;
  /** the category or agent type it ran as */
  category: string | null;
  model: string | null;
  /** `lost`: OmO's process that ran it is gone, or the pane no longer runs the Claude Code session that started it */
  status: "running" | "completed" | "failed" | "cancelled" | "lost";
  started_at: string | null;
  ended_at: string | null;
  turns: number | null;
  tool_calls: number | null;
  tokens: number | null;
  /**
   * What GET /api/pane/background-agent can show of it while it runs: `claude-subagent` for a
   * Claude Code subagent (its own transcript), null for a source it reads nothing of (OmO's tasks,
   * a Claude background command). Absent from a bridge from before the route.
   */
  detail_kind?: "claude-subagent" | null;
}

/** One step of an OmO workflow (a DAG node); `error` is why a failed one failed. */
export interface OmoRunNode {
  id: string;
  label: string;
  state: "pending" | "scheduled" | "running" | "blocked" | "completed" | "failed" | "skipped" | "cancelled";
  error: string | null;
}

/** One OmO workflow (a DAG run): its steps by wave, a wave's steps able to run side by side. */
export interface OmoRun {
  id: string;
  name: string;
  /** `pending` and `paused` have not ended either */
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  started_at: string | null;
  ended_at: string | null;
  waves: OmoRunNode[][];
}

/** GET /api/pane/omo-tasks */
export interface OmoActivity {
  tasks: OmoTask[];
  runs: OmoRun[];
  /** the PC's clock, which the times are on */
  server_time: string;
  /** running tasks that count but are not listed: an OpenCode pane lists the newest thousand that run */
  more_running?: number;
}

/**
 * GET /api/pane/background-agent?pane_id=&agent_id=: what a running Claude Code subagent's own
 * transcript holds now, read-only and bounded (server/claude-subagents.ts backgroundAgentDetail):
 * the prompt it was dispatched with, then its prose and the tools it called, as text. The read
 * covers the start of its file (the prompt) and its end (recent activity): `truncated` when the
 * file, the events or the text went past the `limits`, `incomplete` when a record inside what was
 * read could not be used (torn, over its size, or not a record). `session_id` names the Claude
 * session it belongs to: an opaque identity, never a path.
 */
export interface PaneBackgroundAgentDetail {
  agent_id: string;
  session_id: string;
  title: string | null;
  agent: string | null;
  prompt: string | null;
  /** oldest first; a `tool` event's text is the tool's name, a space, and its arguments as JSON */
  events: Array<{ kind: "text" | "tool"; text: string; at: string | null }>;
  truncated: boolean;
  incomplete: boolean;
  limits: { max_read_bytes: number; max_output_bytes: number; max_events: number };
  /** the PC's clock, which `at` is on */
  server_time: string;
}
