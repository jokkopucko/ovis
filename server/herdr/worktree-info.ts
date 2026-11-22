/**
 * herdr's worktree record, in a file that imports nothing, so code that only names the type
 * (server/herdr-core/worktrees.ts) does not import the whole client.
 */

/** herdr's view of one git checkout: `worktree.list` entries, and what create/open hand back. */
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  label: string;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  open_workspace_id: string | null;
}
