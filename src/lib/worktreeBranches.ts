import type { WorkspaceInfo, WorktreeListing, WorktreeOpened } from "../../shared/protocol.ts";
import { MAX_INVENTORY_WORKSPACES } from "../../shared/workspace-lifecycle.ts";

/** The longest query one inventory read carries: well inside the relay's 4096-character request target (shared/relay-mux.ts). */
export const MAX_INVENTORY_QUERY_CHARS = 2048;

export function inventoryReads(workspaceIds: readonly string[]): string[][] {
  const reads: string[][] = [];
  let read: string[] = [];
  let chars = 0;
  for (const id of workspaceIds) {
    const param = `workspace_id=${encodeURIComponent(id)}`.length + 1;
    if (read.length > 0 && (read.length === MAX_INVENTORY_WORKSPACES || chars + param > MAX_INVENTORY_QUERY_CHARS)) {
      reads.push(read);
      read = [];
      chars = 0;
    }
    read.push(id);
    chars += param;
  }
  if (read.length > 0) reads.push(read);
  return reads;
}

export interface WorkspaceBranch {
  checkoutPath: string;
  branch: string | null;
  isDetached: boolean;
}

interface CheckoutIdentity { repoKey: string; checkoutPath: string }
interface StoredBranch extends WorkspaceBranch { repoKey: string | null }
export interface WorktreeRepository { repoKey: string; workspaceId: string }

/** Compare API checkout paths without changing meaningful spaces or POSIX backslashes. */
export function normalizeCheckoutPath(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
  const separators = windows ? path.replace(/\\/g, "/").replace(/^([a-z]):/i, (_, drive: string) => `${drive.toUpperCase()}:`) : path;
  if (windows && /^[A-Z]:\/+$/i.test(separators)) return separators.slice(0, 3);
  return separators.replace(/\/+$/, "") || "/";
}

function checkoutIdentities(workspaces: readonly WorkspaceInfo[]): Map<string, CheckoutIdentity> {
  const identities = new Map<string, CheckoutIdentity>();
  for (const workspace of workspaces) if (workspace.worktree) identities.set(workspace.workspace_id, {
    repoKey: workspace.worktree.repo_key,
    checkoutPath: normalizeCheckoutPath(workspace.worktree.checkout_path),
  });
  return identities;
}

export function worktreeWorkspaceSignature(workspaces: readonly WorkspaceInfo[]): string {
  return JSON.stringify([...checkoutIdentities(workspaces)].sort(([left], [right]) => left.localeCompare(right))
    .map(([id, identity]) => [id, identity.repoKey, identity.checkoutPath]));
}

export function worktreeRepositories(workspaces: readonly WorkspaceInfo[]): WorktreeRepository[] {
  const repositories = new Map<string, WorkspaceInfo>();
  for (const workspace of workspaces) {
    if (!workspace.worktree) continue;
    const previous = repositories.get(workspace.worktree.repo_key);
    if (!previous || (previous.worktree?.is_linked_worktree && !workspace.worktree.is_linked_worktree)) {
      repositories.set(workspace.worktree.repo_key, workspace);
    }
  }
  return [...repositories].sort(([left], [right]) => left.localeCompare(right))
    .map(([repoKey, workspace]) => ({ repoKey, workspaceId: workspace.workspace_id }));
}

function matches(branch: StoredBranch, identity: CheckoutIdentity): boolean {
  return branch.checkoutPath === identity.checkoutPath && (branch.repoKey === null || branch.repoKey === identity.repoKey);
}

export class WorkspaceBranchCache {
  private identities = new Map<string, CheckoutIdentity>();
  private records = new Map<string, StoredBranch>();
  private unmarked = new Map<string, WorkspaceBranch>();
  private signature = "";
  private revision = 0;

  get generation(): number { return this.revision; }

  invalidate(): void { this.revision++; }

  reconcile(workspaces: readonly WorkspaceInfo[]): void {
    const signature = worktreeWorkspaceSignature(workspaces);
    if (signature === this.signature) return;
    this.signature = signature;
    this.identities = checkoutIdentities(workspaces);
    this.invalidate();
    const retained = new Map<string, StoredBranch>();
    for (const [id, branch] of this.records) {
      const identity = this.identities.get(id);
      if (identity && matches(branch, identity)) retained.set(id, { ...branch, repoKey: identity.repoKey });
    }
    this.records = retained;
  }

  rememberOpened(opened: WorktreeOpened): void {
    this.invalidate();
    if (opened.branch == null) {
      // The response has no detached flag. Await the inventory before calling it detached.
      this.records.delete(opened.workspace_id);
      return;
    }
    const checkoutPath = normalizeCheckoutPath(opened.path);
    const identity = this.identities.get(opened.workspace_id);
    this.records.set(opened.workspace_id, {
      checkoutPath,
      branch: opened.branch,
      isDetached: false,
      repoKey: identity?.checkoutPath === checkoutPath ? identity.repoKey : null,
    });
  }

  applyListing(repoKey: string, listing: WorktreeListing, generation: number): boolean {
    if (generation !== this.revision || listing.source.repo_key !== repoKey) return false;
    for (const [id, identity] of this.identities) {
      if (identity.repoKey !== repoKey) continue;
      const entry = listing.worktrees.find((candidate) => candidate.open_workspace_id === id
        && normalizeCheckoutPath(candidate.path) === identity.checkoutPath);
      if (!entry) { this.records.delete(id); continue; }
      this.records.set(id, {
        repoKey,
        checkoutPath: identity.checkoutPath,
        branch: entry.branch ?? null,
        isDetached: entry.is_detached,
      });
    }
    return true;
  }

  applyUnmarked(workspaceId: string, listing: WorktreeListing, generation: number): boolean {
    if (generation !== this.revision) return false;
    const source = normalizeCheckoutPath(listing.source.source_checkout_path);
    const entry = listing.worktrees.find((candidate) => normalizeCheckoutPath(candidate.path) === source);
    if (!entry) return this.unmarked.delete(workspaceId);
    const before = this.unmarked.get(workspaceId);
    const branch = { checkoutPath: source, branch: entry.branch ?? null, isDetached: entry.is_detached };
    this.unmarked.set(workspaceId, branch);
    return before?.branch !== branch.branch || before.isDetached !== branch.isDetached || before.checkoutPath !== branch.checkoutPath;
  }

  forgetUnmarked(workspaceId: string, generation: number): boolean {
    return generation === this.revision && this.unmarked.delete(workspaceId);
  }

  branchesFor(workspaces: readonly WorkspaceInfo[], unmarked: ReadonlySet<string> = new Set()): ReadonlyMap<string, WorkspaceBranch> {
    const branches = new Map<string, WorkspaceBranch>();
    for (const workspace of workspaces) {
      const branch = workspace.worktree ? undefined : unmarked.has(workspace.workspace_id) ? this.unmarked.get(workspace.workspace_id) : undefined;
      if (branch) branches.set(workspace.workspace_id, branch);
    }
    for (const [id, identity] of checkoutIdentities(workspaces)) {
      const branch = this.records.get(id);
      if (branch && matches(branch, identity)) branches.set(id, {
        checkoutPath: branch.checkoutPath,
        branch: branch.branch,
        isDetached: branch.isDetached,
      });
    }
    return branches;
  }
}
