import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSnapshot, WorktreeOpened } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { publishBranches } from "./paneBranch.ts";
import { usePageVisible } from "./visibility.ts";
import { WorkspaceBranchCache, worktreeRepositories, worktreeWorkspaceSignature, type WorkspaceBranch } from "./worktreeBranches.ts";

const BRANCH_POLL_MS = 30_000;
const NONE: ReadonlySet<string> = new Set();

/** Use the existing worktree API; pane status updates never trigger a git inventory poll. */
/** `roster`: this reader is the PC's roster, whose branches the panes' composers name too (lib/paneBranch.ts). */
/** `unmarked`: git workspaces herdr has not marked as a repository's (no `worktree`), read one by one. */
/** `watching`: this device may only watch, and the PC refuses it the listing (#2250): nothing is asked. */
/** `onNotCheckout`: herdr answered that an unmarked workspace is no git checkout, so whoever chose it can stop asking (#2726). */
export function useWorktreeBranches(snapshot: SessionSnapshot | null, online: boolean, roster = false, unmarked: ReadonlySet<string> = NONE, watching = false, onNotCheckout?: (workspaceId: string) => void): {
  branches: ReadonlyMap<string, WorkspaceBranch>;
  rememberOpened(opened: WorktreeOpened): void;
} {
  const machineId = useMachineId();
  const { listWorktrees } = useMachineApi();
  const visible = usePageVisible();
  // `refused`: the PC answered that this device may only watch (#2250): it is not asked again until the
  // device's role changes, which starts over (a device signed in to drive reads branches again)
  const owner = useMemo(() => ({ cache: new WorkspaceBranchCache(), pending: null as Promise<void> | null, refused: watching }), [machineId, watching]);
  const [, publish] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const workspaces = snapshot?.workspaces ?? [];
  const signature = worktreeWorkspaceSignature(workspaces);
  const unmarkedKey = [...unmarked].sort().join("\n");

  useEffect(() => {
    owner.cache.reconcile(workspaces);
    const repositories = worktreeRepositories(workspaces);
    const unmarkedIds = unmarkedKey === "" ? [] : unmarkedKey.split("\n");
    if (!online || !visible || owner.refused || (repositories.length === 0 && unmarkedIds.length === 0)) {
      owner.cache.invalidate();
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      // A create or structural change may restart this effect while its previous RPC awaits.
      // Wait for that same-PC cycle to finish before opening another inventory connection.
      if (owner.pending) await owner.pending;
      if (stopped || owner.refused) return;
      const generation = owner.cache.generation;
      const cycle = (async () => {
        let changed = false;
        for (const repository of repositories) {
          if (stopped || owner.refused || generation !== owner.cache.generation) break;
          try {
            const listing = await listWorktrees(repository.workspaceId);
            if (!stopped) changed = owner.cache.applyListing(repository.repoKey, listing, generation) || changed;
          } catch (error) {
            // Retain a last known branch only while its exact checkout still exists.
            if (error instanceof ApiError && error.code === "read_only") owner.refused = true;
          }
        }
        for (const workspaceId of unmarkedIds) {
          if (stopped || owner.refused || generation !== owner.cache.generation) break;
          try {
            const listing = await listWorktrees(workspaceId);
            if (!stopped) changed = owner.cache.applyUnmarked(workspaceId, listing, generation) || changed;
          } catch (error) {
            if (error instanceof ApiError && error.code === "read_only") { owner.refused = true; break; }
            // a refusal (4xx) says it is no checkout now; a failure to ask keeps the last known branch
            if (!stopped && error instanceof ApiError && error.status < 500) {
              changed = owner.cache.forgetUnmarked(workspaceId, generation) || changed;
              // only this cycle's git refusal says so: herdr's dropped connections are 404s too (server/http.ts)
              if (generation === owner.cache.generation && error.code === "not_git_worktree") onNotCheckout?.(workspaceId);
            }
          }
        }
        if (!stopped && changed) publish((value) => value + 1);
      })();
      owner.pending = cycle;
      await cycle;
      if (owner.pending === cycle) owner.pending = null;
      if (!stopped && !owner.refused) timer = setTimeout(() => void poll(), BRANCH_POLL_MS);
    }

    void poll();
    return () => {
      stopped = true;
      owner.cache.invalidate();
      clearTimeout(timer);
    };
  }, [owner, listWorktrees, signature, unmarkedKey, online, visible, refresh, onNotCheckout]);

  const rememberOpened = useCallback((opened: WorktreeOpened): void => {
    owner.cache.rememberOpened(opened);
    setRefresh((value) => value + 1);
  }, [owner]);

  const branches = owner.cache.branchesFor(workspaces, unmarked);
  useEffect(() => { if (roster) publishBranches(machineId, branches); });
  useEffect(() => roster ? () => publishBranches(machineId, null) : undefined, [roster, machineId]);

  return { branches, rememberOpened };
}
