interface GroupedWorkspace {
  workspace_id: string;
  worktree?: { is_linked_worktree: boolean; repo_key: string } | null;
}

/**
 * The sidebar's tree: a repository's worktree workspaces hang under a workspace on its main checkout. With
 * more than one open on that checkout, each worktree takes the nearest one before it, else the first;
 * a worktree whose repository has none open stays at the top level, in its own place.
 */
export function worktreeGroups<W extends GroupedWorkspace>(ordered: readonly W[]): { workspace: W; children: W[] }[] {
  const firstByRepo = new Map<string, W>();
  for (const workspace of ordered) {
    if (workspace.worktree && !workspace.worktree.is_linked_worktree && !firstByRepo.has(workspace.worktree.repo_key)) firstByRepo.set(workspace.worktree.repo_key, workspace);
  }
  const nearestByRepo = new Map<string, W>();
  const childrenOf = new Map<string, W[]>();
  const top: W[] = [];
  for (const workspace of ordered) {
    const worktree = workspace.worktree;
    if (worktree && !worktree.is_linked_worktree) nearestByRepo.set(worktree.repo_key, workspace);
    const parent = worktree?.is_linked_worktree ? nearestByRepo.get(worktree.repo_key) ?? firstByRepo.get(worktree.repo_key) : undefined;
    if (!parent) { top.push(workspace); continue; }
    const children = childrenOf.get(parent.workspace_id) ?? [];
    children.push(workspace);
    childrenOf.set(parent.workspace_id, children);
  }
  return top.map((workspace) => ({ workspace, children: childrenOf.get(workspace.workspace_id) ?? [] }));
}
