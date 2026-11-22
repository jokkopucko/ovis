import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSnapshot, WorktreeListing, WorktreeOpened } from "../../shared/protocol.ts";
import { ApiError, routeMissing } from "./api.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { publishBranches } from "./paneBranch.ts";
import { usePageVisible } from "./visibility.ts";
import { inventoryReads, WorkspaceBranchCache, worktreeRepositories, worktreeWorkspaceSignature, type WorkspaceBranch } from "./worktreeBranches.ts";

const BRANCH_POLL_MS = 30_000;
const NONE: ReadonlySet<string> = new Set();

/** `unmarked`: git workspaces herdr has not marked as a repository's (no `worktree`), read one by one. */
/** `watching`: this device may only watch, and the PC refuses it the listing (#2250): nothing is asked. */
export function useWorktreeBranches(snapshot: SessionSnapshot | null, online: boolean, roster = false, unmarked: ReadonlySet<string> = NONE, watching = false, onNotCheckout?: (workspaceId: string) => void): {
  branches: ReadonlyMap<string, WorkspaceBranch>;
  rememberOpened(opened: WorktreeOpened): void;
} {
  const machineId = useMachineId();
  const { listWorktrees, readWorktreeInventory } = useMachineApi();
  const visible = usePageVisible();
  // `refused`: the PC answered that this device may only watch (#2250): it is not asked again until the
  // device's role changes, which starts over (a device signed in to drive reads branches again).
  // `oneByOne`: the PC's bridge is from before GET /api/worktree/inventory, so each workspace is asked alone (#2661).
  const owner = useMemo(() => ({ cache: new WorkspaceBranchCache(), pending: null as Promise<void> | null, refused: watching, oneByOne: false, turn: 0 }), [machineId, watching]);
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
      if (!online) owner.oneByOne = false;
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      if (owner.pending) await owner.pending;
      if (stopped || owner.refused) return;
      const generation = owner.cache.generation;
      const cycle = (async () => {
        let changed = false;
        const answered = new Map<string, WorktreeListing | ApiError>();
        let unanswered = false;
        const asked = [...repositories.map((repository) => repository.workspaceId), ...unmarkedIds];
        const start = owner.turn++ % asked.length;
        for (const read of owner.oneByOne ? [] : inventoryReads([...asked.slice(start), ...asked.slice(0, start)])) {
          if (stopped || owner.refused || generation !== owner.cache.generation) return;
          try {
            const inventory = await readWorktreeInventory(read);
            for (const entry of inventory.entries) {
              answered.set(entry.workspace_id, "listing" in entry ? entry.listing
                : new ApiError("worktree/list", entry.error.status, entry.error.message, entry.error.code));
            }
          } catch (error) {
            if (routeMissing(error)) { if (!stopped) owner.oneByOne = true; break; }
            if (error instanceof ApiError && error.code === "read_only") { owner.refused = true; return; }
            unanswered = true;
            break;
          }
        }
        const listingOf = async (workspaceId: string): Promise<WorktreeListing | null> => {
          const answer = answered.get(workspaceId);
          if (answer instanceof ApiError) throw answer;
          return answer ?? (unanswered ? null : await listWorktrees(workspaceId));
        };
        for (const repository of repositories) {
          if (stopped || owner.refused || generation !== owner.cache.generation) break;
          try {
            const listing = await listingOf(repository.workspaceId);
            if (listing && !stopped) changed = owner.cache.applyListing(repository.repoKey, listing, generation) || changed;
          } catch (error) {
            if (error instanceof ApiError && error.code === "read_only") owner.refused = true;
          }
        }
        for (const workspaceId of unmarkedIds) {
          if (stopped || owner.refused || generation !== owner.cache.generation) break;
          try {
            const listing = await listingOf(workspaceId);
            if (listing && !stopped) changed = owner.cache.applyUnmarked(workspaceId, listing, generation) || changed;
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
  }, [owner, listWorktrees, readWorktreeInventory, signature, unmarkedKey, online, visible, refresh, onNotCheckout]);

  const rememberOpened = useCallback((opened: WorktreeOpened): void => {
    owner.cache.rememberOpened(opened);
    setRefresh((value) => value + 1);
  }, [owner]);

  const branches = owner.cache.branchesFor(workspaces, unmarked);
  useEffect(() => { if (roster) publishBranches(machineId, branches); });
  useEffect(() => roster ? () => publishBranches(machineId, null) : undefined, [roster, machineId]);

  return { branches, rememberOpened };
}
