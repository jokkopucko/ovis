import type { PullRequestCheck, PullRequestCheckLog, PullRequestMergeMethod, PullRequestThread, PullRequestView } from "../../shared/pull-request.ts";
import { ApiError, routeMissing } from "./api.ts";
import { codeFence } from "./diffLineNotes.ts";
import type { Translate } from "./i18n.ts";
import { quoteBlock } from "./replyComments.ts";

const checkName = (check: PullRequestCheck): string => check.workflow === null ? check.name : `${check.workflow} / ${check.name}`;

/** What Send to agent puts in the draft for a failing check: its name, its page, and its log's last lines when it has one. */
export function checkDraft(view: Pick<PullRequestView, "number">, check: PullRequestCheck, log: PullRequestCheckLog | null): string {
  const head = `The check "${checkName(check)}" failed on pull request #${view.number}${check.url === null ? "" : ` (${check.url})`}.`;
  if (log === null || log.text.trim() === "") return head;
  const fence = codeFence(log.text);
  return `${head}\nThe last lines of its log:\n\n${fence}\n${log.text}\n${fence}`;
}

/** What Send to agent puts in the draft for a review thread: where it is, who wrote it, and its first comment quoted. */
export function threadDraft(view: Pick<PullRequestView, "number">, thread: PullRequestThread): string {
  const place = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
  const by = thread.author === null ? "" : ` from @${thread.author}`;
  const link = thread.url === null ? "" : ` (${thread.url})`;
  return `Review comment on ${place} in pull request #${view.number}${by}${link}:\n\n${quoteBlock(thread.body)}`;
}

export function mergeLabel(t: Translate, method: PullRequestMergeMethod): string {
  switch (method) {
    case "squash": return t("Squash and merge");
    case "rebase": return t("Rebase and merge");
    case "merge": return t("Merge pull request");
  }
}

/** Why Merge is off, in GitHub's terms; null when it is on. */
export function mergeBlockedWord(t: Translate, view: PullRequestView): string | null {
  if (view.mergeable) return null;
  if (view.state === "merged") return t("Already merged.");
  if (view.state === "closed") return t("This pull request is closed.");
  if (view.draft) return t("A draft cannot be merged; mark it ready on GitHub first.");
  if (view.merge_queue) return t("This base branch merges through a merge queue; merge it on GitHub.");
  switch (view.merge_state) {
    case "blocked": return t("Required checks or reviews have not passed yet.");
    case "behind": return t("The branch is behind its base; update it first.");
    case "dirty": return t("The branch has conflicts with its base.");
    case "unknown": return t("GitHub is still working out whether it can merge; refresh in a moment.");
    default: return t("GitHub would not merge this pull request now.");
  }
}

/** `pc`: the PC's name the words are prefixed with (another PC, or this one among several); none for this PC alone */
export function pullRequestErrorMessage(t: Translate, error: unknown, pc?: string): string {
  const pcPrefix = pc ? `[${pc}] ` : "";
  if (!(error instanceof ApiError)) return `${pcPrefix}${t("The pull request could not be loaded.")}`;
  if (routeMissing(error)) return `${pcPrefix}${t("This PC's bridge cannot show pull requests yet.")}`;
  switch (error.code) {
    case "gh_missing": return `${pcPrefix}${t("GitHub CLI (gh) is not installed on this PC. Install it and sign in with gh auth login to see pull requests here.")}`;
    case "gh_signed_out": return `${pcPrefix}${t("GitHub CLI (gh) on this PC is not signed in. Run gh auth login there to see pull requests here.")}`;
    case "no_pull_request": return t("This branch has no pull request.");
    case "no_github_remote": return t("This repository has no GitHub remote.");
    case "not_a_repository": return t("This folder is not in a git repository.");
    case "gh_timeout": return `${pcPrefix}${t("gh took too long to answer.")}`;
    case "merge_queue": return t("This base branch merges through a merge queue; merge it on GitHub.");
    case "pull_request_changed": return t("The pull request changed since it was shown. Refresh it, then merge.");
    case "merge_refused": case "gh_failed": return `${pcPrefix}${error.detail || t("The pull request could not be loaded.")}`;
    case "read_only": return t("This device can only watch.");
    case "invalid_cwd": case "pane_not_found": return `${pcPrefix}${t("The pane's folder could not be read.")}`;
    case "machine_offline": case "machine_unavailable": case "machine_timeout": return `${pcPrefix}${t("That PC is not reachable right now.")}`;
    default: return `${pcPrefix}${t("The pull request could not be loaded.")}`;
  }
}
