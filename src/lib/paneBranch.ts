import { useSyncExternalStore } from "react";
import type { WorkspaceBranch } from "./worktreeBranches.ts";

/**
 * The roster stays the one reader of the git inventory:
 * a second reader per pane would ask every repository twice.
 */
export const DETACHED = "\0detached";

const published = new Map<string, ReadonlyMap<string, string>>();
const listeners = new Set<() => void>();

export function branchWords(branches: ReadonlyMap<string, WorkspaceBranch>): Map<string, string> {
  const words = new Map<string, string>();
  for (const [workspaceId, branch] of branches) {
    if (branch.branch !== null && branch.branch.trim() !== "") words.set(workspaceId, branch.branch);
    else if (branch.isDetached) words.set(workspaceId, DETACHED);
  }
  return words;
}

export function publishBranches(machineId: string, branches: ReadonlyMap<string, WorkspaceBranch> | null): void {
  const next = branches === null ? new Map<string, string>() : branchWords(branches);
  const before = published.get(machineId) ?? new Map<string, string>();
  if (before.size === next.size && [...next].every(([workspaceId, word]) => before.get(workspaceId) === word)) return;
  if (next.size === 0) published.delete(machineId);
  else published.set(machineId, next);
  for (const listener of [...listeners]) listener();
}

export function publishedBranch(machineId: string, workspaceId: string | null): string | null {
  return workspaceId === null ? null : published.get(machineId)?.get(workspaceId) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePaneBranch(machineId: string, workspaceId: string | null): string | null {
  return useSyncExternalStore(subscribe, () => publishedBranch(machineId, workspaceId));
}
