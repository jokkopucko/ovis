import type { TabInfo as HerdrTab } from "./herdr-api.generated.ts";

/**
 * POST /api/workspace/move's answer. `order_epoch` and `moved_seq` (from 1) say which move this was
 * in the server's order: a snapshot of the same epoch with `read_seq >= moved_seq` was read after
 * it. Absent from an older server.
 */
export interface WorkspaceMoved { ok: true; order_epoch?: string; moved_seq?: number }

export interface CreateWorkspaceRequest {
  cwd?: string | null;
  label?: string | null;
  agent?: { kind: string; name?: string; args?: string[] } | null;
  /**
   * the user's first message for the agent, sent by this request: the bridge queues it for the
   * agent's first ready turn through its pending path (server/core/pending.ts), where the pane's
   * connections see it as a pending message and may discard or send it now; needs `agent`, at most
   * 20000 characters without terminal control characters (shared/launch-rules.ts). Leave it out when there
   * is none: a bridge that predates it answers without `first_message`, which tells the page it was not taken.
   */
  first_message?: string | null;
  /**
   * the `connection` of this page's socket to the PC (its first snapshot): the one connection that types
   * the first message on its own, while it has the pane attached. Without it, or once that connection
   * closes before the message went, the message is held for an explicit Send now or Discard.
   */
  first_message_connection?: string;
  /** environment variables for the new pane's shell (and an agent it starts); see POST /api/workspace/create in shared/protocol.ts */
  env?: Record<string, string> | null;
}

/** POST /api/tab/move: the boundary is counted BEFORE removing the source tab. */
export interface MoveTabRequest { tab_id: string; insert_index: number; }
export interface TabMoved {
  ok: true;
  tabs: HerdrTab[];
}

/** POST /api/tab/move-to-workspace: where the tab's pane is now, under its new ID. */
export interface MoveTabToWorkspaceRequest { tab_id: string; workspace_id: string; }
export interface TabMovedToWorkspace {
  ok: true;
  pane_id: string;
  tab_id: string;
}

/** POST /api/tab/create: the workspace is required; `label` names the new tab. */
export interface CreateTabRequest extends CreateWorkspaceRequest {
  workspace_id: string;
}

/** POST /api/workspace/create: the workspace herdr made and the pane the agent (if any) runs in. */
/** POST /api/worktree/create: branch is the new checkout's branch (created from base, or HEAD, unless it exists). */
export interface CreateWorktreeRequest {
  workspace_id: string;
  branch: string;
  base?: string | null;
  label?: string | null;
  /** an absolute checkout path; herdr's `<worktrees.directory>/<repo>/<branch>` when absent */
  path?: string | null;
  /** started in the new workspace's root pane, as /api/workspace/create starts one */
  agent?: { kind: string; name?: string; args?: string[] } | null;
}

/** POST /api/worktree/open: one of path or branch names the checkout. */
export interface OpenWorktreeRequest {
  workspace_id: string;
  path?: string | null;
  branch?: string | null;
  label?: string | null;
}

/** The workspace a worktree is open in, and its root pane. `already_open` when open before the call. */
export interface WorktreeOpened {
  workspace_id: string;
  pane_id: string;
  already_open: boolean;
  path: string;
  branch: string | null;
  /** create with `agent` only: whether herdr reported it ready in the root pane */
  agent_started?: boolean;
  /** The worktree's workspace still exists when its requested agent could not start. */
  error?: { code: string; message: string };
}

/** POST /api/worktree/remove: `git worktree remove` of the workspace's checkout; force when git refuses a dirty one. */
export interface RemoveWorktreeRequest {
  workspace_id: string;
  force?: boolean;
}

export interface WorktreeRemoved {
  ok: true;
  path: string;
  forced: boolean;
}

/** One checkout of a repository, from herdr's `worktree.list` (git worktree list, annotated). */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  label: string;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  /** the herdr workspace this checkout is open in, if any */
  open_workspace_id: string | null;
}

/** GET /api/worktree/list: the repository the workspace is in, and every checkout of it. */
export interface WorktreeListing {
  source: { repo_key: string; repo_name: string; repo_root: string; source_checkout_path: string; source_workspace_id: string | null };
  worktrees: WorktreeEntry[];
}

export interface WorkspaceCreated {
  workspace_id: string;
  pane_id: string;
  /** true when `agent` was requested and herdr reported it ready in the root pane */
  agent_started: boolean;
  /** The workspace still exists when its requested agent could not start. */
  error?: { code: string; message: string };
  /**
   * with `first_message` in the request: the pending message it was queued as; null when the agent did
   * not start; `error` when the agent started but the message could not be queued (the page keeps its
   * text). Absent from a bridge that predates `first_message`. `held`: the message is held from the
   * start rather than queued, with its pending code (`first_message_unattended` when the request named
   * no page connection that could type it); it waits for Send now or Discard. Absent when queued.
   */
  first_message?: { id: string; held?: string } | { error: { code: string; message: string } } | null;
}

/**
 * POST /api/tab/create: the existing workspace and the new tab's root pane. A failed agent
 * launch leaves the tab there, reachable through pane_id, as workspace creation does.
 */
export type TabCreated = WorkspaceCreated;
