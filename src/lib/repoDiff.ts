import type { RepoBranchComparison, RepoDiffFilePatch, RepoDiffScope, RepoDiffStatus } from "../../shared/protocol.ts";
import { ApiError, routeMissing } from "./api.ts";
import { REPO_DIFF_KEY } from "./historyKeys.ts";
import { formatBytes } from "./bridgeProgress.ts";
import { canHighlight, countLines, languageForPath } from "./highlight.ts";
import type { Translate } from "./i18n.ts";
import type { DiffStyle } from "./settings.ts";
import { VIRTUAL_HIGHLIGHT_CHARS, VIRTUAL_HIGHLIGHT_LINES } from "./sourcePreview.ts";

export interface RepoComparison {
  scope: RepoDiffScope;
  base: string | null;
  head: string | null;
  comparison: RepoBranchComparison | null;
}

export interface RepoDiffTarget extends RepoComparison {
  machineId: string;
  paneId: string | null;
  directory: string | null;
  path: string;
  oldPath: string | null;
}

export const REPO_DIFF_SCOPES: readonly RepoDiffScope[] = ["workspace", "staged", "commit", "branch"];

export function refName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

export function sameComparison(left: RepoBranchComparison | null, right: RepoBranchComparison | null): boolean {
  if (left === null || right === null) return left === right;
  return left.repository_root === right.repository_root && left.head_oid === right.head_oid && left.base_oid === right.base_oid && left.merge_base_oid === right.merge_base_oid;
}

/** git's own letter for a status, as `git status --short` prints it. */
export const STATUS_MARK: Record<RepoDiffStatus, string> = {
  added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C", type_changed: "T", unmerged: "U", untracked: "?",
};

export function statusWord(t: Translate, status: RepoDiffStatus): string {
  switch (status) {
    case "added": return t("Added");
    case "deleted": return t("Deleted");
    case "modified": return t("Modified");
    case "renamed": return t("Renamed");
    case "copied": return t("Copied");
    case "type_changed": return t("Type changed");
    case "unmerged": return t("Conflict");
    case "untracked": return t("Untracked");
  }
}

export function shortHash(revision: string): string {
  return /^[0-9a-f]{40,64}$/.test(revision) ? revision.slice(0, 7) : revision;
}

export function comparisonWord(t: Translate, comparison: RepoComparison): string {
  switch (comparison.scope) {
    case "workspace": return t("Working tree");
    case "staged": return t("Staged");
    case "commit": return `${shortHash(comparison.base ?? "")}..${shortHash(comparison.head ?? "HEAD")}`;
    case "branch": return t("Since {base}", { base: comparison.base ?? "" });
  }
}

export function nothingChangedWord(t: Translate, scope: RepoDiffScope): string {
  switch (scope) {
    case "workspace": return t("No uncommitted changes");
    case "staged": return t("Nothing staged");
    case "commit": return t("These commits are the same");
    case "branch": return t("Nothing changed since the base");
  }
}

/** A refusal of the diff routes, in the user's words: never git's stderr, which the server keeps. */
export function diffErrorMessage(t: Translate, error: unknown): string {
  if (!(error instanceof ApiError)) return t("Changes could not be loaded.");
  if (routeMissing(error)) return t("This PC's bridge cannot show changes yet.");
  switch (error.code) {
    case "not_a_repository": return t("This folder is not in a git repository.");
    case "revision_not_found": return t("No commit by that name.");
    case "invalid_revision": return t("Name a commit, branch or tag.");
    case "invalid_scope": return t("This PC's bridge cannot compare branches yet.");
    case "unborn_head": return t("The repository has no commits yet, so there is no branch to compare.");
    case "no_common_ancestor": return t("That base shares no history with HEAD.");
    case "comparison_changed": return comparisonChangedWord(t);
    case "invalid_comparison": return t("This comparison is not one the list answered; refresh the list.");
    case "git_unavailable": return t("git is not installed on that PC.");
    case "git_timeout": return t("git took too long to answer.");
    case "git_failed": return t("git could not compare these.");
    case "read_only": return t("This device can only watch.");
    case "invalid_cwd": case "pane_not_found": return t("The pane's folder could not be read.");
    case "machine_offline": case "machine_unavailable": case "machine_timeout": return t("That PC is not reachable right now.");
    default: return t("Changes could not be loaded.");
  }
}

export function comparisonChangedWord(t: Translate): string {
  return t("HEAD or the repository changed since the list was read; refresh the list.");
}

export function unavailableMessage(t: Translate, answer: RepoDiffFilePatch): string | null {
  switch (answer.unavailable) {
    case null: return null;
    case "binary": return t("This is a binary file; there are no lines to compare.");
    case "too_large": return t("This change is larger than {limit} and is not shown here.", { limit: formatBytes(answer.limits.max_patch_bytes) });
    case "unmerged": return t("This file has a merge conflict; resolve it in the terminal first.");
    case "unsupported": return t("This path is not a regular file.");
  }
}

export function diffColorable(name: string, patch: string): boolean {
  return canHighlight(languageForPath(name)) && patch.length <= VIRTUAL_HIGHLIGHT_CHARS && countLines(patch) <= VIRTUAL_HIGHLIGHT_LINES;
}

export function diffStyleFor(setting: DiffStyle, narrow: boolean): DiffStyle {
  return narrow ? "unified" : setting;
}

export function repositoryFilePath(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${path}`;
}

const HISTORY_KEY = REPO_DIFF_KEY;

export function diffTargetFromState(state: unknown): RepoDiffTarget | null {
  if (state === null || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[HISTORY_KEY];
  if (entry === null || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  const text = (key: string): string | null => (typeof value[key] === "string" ? value[key] as string : null);
  const optional = (key: string): boolean => value[key] === null || typeof value[key] === "string";
  const machineId = text("machineId"), path = text("path"), scope = text("scope");
  if (machineId === null || path === null || scope === null || !REPO_DIFF_SCOPES.includes(scope as RepoDiffScope)) return null;
  if (!optional("paneId") || !optional("directory") || !optional("base") || !optional("head") || !optional("oldPath")) return null;
  const comparison = branchComparisonOf(value["comparison"]);
  if (comparison === undefined) return null;
  return { machineId, paneId: text("paneId"), directory: text("directory"), scope: scope as RepoDiffScope, base: text("base"), head: text("head"), comparison, path, oldPath: text("oldPath") };
}

function branchComparisonOf(value: unknown): RepoBranchComparison | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const field = (key: string): string | undefined => (typeof record[key] === "string" ? record[key] as string : undefined);
  const repositoryRoot = field("repository_root"), headOid = field("head_oid"), baseOid = field("base_oid"), mergeBaseOid = field("merge_base_oid");
  if (repositoryRoot === undefined || headOid === undefined || baseOid === undefined || mergeBaseOid === undefined) return undefined;
  return { repository_root: repositoryRoot, head_oid: headOid, base_oid: baseOid, merge_base_oid: mergeBaseOid };
}

export function diffTargetState(state: unknown, target: RepoDiffTarget | null): Record<string, unknown> {
  const next = { ...(state !== null && typeof state === "object" ? state as Record<string, unknown> : {}) };
  if (target === null) delete next[HISTORY_KEY];
  else next[HISTORY_KEY] = target;
  return next;
}
