import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleCheck, CircleDot, CircleMinus, CircleX, ExternalLink, GitBranch, GitMerge, MessageSquare, RefreshCw } from "lucide-react";

import "./PullRequestPanel.css";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Skeleton } from "./Skeleton.tsx";

import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";
import type { PullRequestCheck, PullRequestCheckState, PullRequestThread, PullRequestView } from "../../shared/pull-request.ts";
import { blockIntoComposer } from "../lib/chatQuote.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { skeletonRows } from "../lib/skeleton.ts";
import { checkDraft, mergeBlockedWord, mergeLabel, pullRequestErrorMessage, threadDraft } from "../lib/pullRequest.ts";

export interface PullRequestPanelProps {
  paneId: string;
  /** the pane's folder, read when the pane is gone */
  directory: string;
  /** the PC's name where it says which PC (another PC, or this one among several), in place of its id */
  machineName?: string;
}

type Load = { status: "pending" } | { status: "failed"; error: unknown } | { status: "ready"; view: PullRequestView };
const PENDING: Load = { status: "pending" };

/** How a Send to agent went, per row: on its way, in the draft (with or without the log), or too long for it. */
type Sent = "sending" | "added" | "added_without_log" | "too_long";

const STATE_ICON: Record<PullRequestCheckState, typeof CircleCheck> = { pass: CircleCheck, fail: CircleX, pending: CircleDot, skipped: CircleMinus, neutral: CircleMinus };

/**
 * The pull request of the pane's branch, as the PC running it reads it through its own gh sign-in
 * (the layout follows GitHub's mobile app: the title and state, then checks, then conversations):
 * read when the tab opens and on Refresh, never polled. Send to agent puts a failing check's log, or
 * a review comment, into the pane's draft and sends nothing. Merge asks first, and merges only the
 * head that was shown, with the repository's default method.
 */
export function PullRequestPanel({ paneId, directory, machineName }: PullRequestPanelProps) {
  const t = useT();
  const locale = useLocale();
  const machineId = useMachineId();
  const { fetchPullRequest, fetchPullRequestLog, mergePullRequest } = useMachineApi();
  const target = useMemo(() => ({ paneId, directory }), [paneId, directory]);
  const [load, setLoad] = useState<Load>(PENDING);
  const [sent, setSent] = useState<ReadonlyMap<string, Sent>>(() => new Map());
  const [confirming, setConfirming] = useState(false);
  const request = useRef(0);
  const checksId = useId();
  const threadsId = useId();

  const read = useCallback(() => {
    const id = ++request.current;
    setLoad(PENDING);
    setSent(new Map());
    fetchPullRequest(target).then(
      (view) => { if (id === request.current) setLoad({ status: "ready", view }); },
      (error: unknown) => { if (id === request.current) setLoad({ status: "failed", error }); },
    );
  }, [fetchPullRequest, target]);
  // another pane or PC, or a closed tab: what is on its way for the last one is dropped when it lands
  useEffect(() => { read(); return () => { request.current += 1; }; }, [read]);

  const paneKey = paneStorageId(machineId, paneId);
  const mark = (key: string, value: Sent): void => setSent((current) => new Map(current).set(key, value));
  const sendCheck = async (view: PullRequestView, check: PullRequestCheck, key: string): Promise<void> => {
    mark(key, "sending");
    let log = null;
    // a log that cannot be read still leaves the check's name and page to send
    if (check.job_id !== null) log = await fetchPullRequestLog(target, check.job_id, new URL(view.url).host).catch(() => null);
    const added = blockIntoComposer(paneKey, checkDraft(view, check, log));
    mark(key, !added ? "too_long" : check.job_id !== null && log === null ? "added_without_log" : "added");
  };
  const sendThread = (view: PullRequestView, thread: PullRequestThread, key: string): void => {
    mark(key, blockIntoComposer(paneKey, threadDraft(view, thread)) ? "added" : "too_long");
  };

  const sentNote = (key: string) => {
    const state = sent.get(key);
    if (state === undefined || state === "sending") return null;
    const text = state === "too_long" ? t("Too long for the message box; shorten the draft first.")
      : state === "added_without_log" ? t("Added to the message box without its log, which could not be read.")
      : t("Added to the message box. Review it, then press Send.");
    return <p className="pull-request-sent" role="status" data-state={state}>{text}</p>;
  };
  const sendButton = (key: string, run: () => void) => (
    <button type="button" className="btn pull-request-send" disabled={sent.get(key) === "sending"} onClick={run}>{t("Send to agent")}</button>
  );

  const view = load.status === "ready" ? load.view : null;
  const failing = view?.checks.filter((check) => check.state === "fail").length ?? 0;
  const pending = view?.checks.filter((check) => check.state === "pending").length ?? 0;
  const passed = view?.checks.filter((check) => check.state === "pass").length ?? 0;
  const blocked = view === null ? null : mergeBlockedWord(t, view);
  const stateWord = view === null ? "" : view.state === "merged" ? t("Merged") : view.state === "closed" ? t("Closed without merging") : view.draft ? t("Draft") : t("Ready for review");
  const pcName = machineName ?? (machineId !== LOCAL_MACHINE ? machineId : null);
  const pcPrefix = pcName !== null ? `${pcName} · ` : "";
  const fallbackHeading = load.status === "pending"
    ? `${pcPrefix}${t("Loading…")}`
    : `${pcPrefix}${directory || t("Pull request")}`;

  return (
    <div className="pull-request" role="group" aria-label={t("Pull request")} aria-busy={load.status === "pending"}>
      <div className="pull-request-bar">
        {view === null
          ? <span className="pull-request-heading" title={directory || undefined}><span dir="ltr">{fallbackHeading}</span></span>
          : <a className="pull-request-heading pull-request-title" href={view.url} target="_blank" rel="noreferrer" title={view.title}>
            <span className="pull-request-number">#{view.number}</span> <span>{view.title}</span>
            <ExternalLink aria-hidden="true" />
          </a>}
        <button type="button" className="icon-button" aria-label={t("Refresh pull request")} title={t("Refresh pull request")} disabled={load.status === "pending"} onClick={read}>
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      {load.status === "pending" && <div className="pull-request-loading" role="status">
        <span className="visually-hidden">{t("Loading…")}</span>
        {skeletonRows(4).map((width, index) => <Skeleton key={index} width={width} />)}
      </div>}
      {load.status === "failed" && <p className="pull-request-note pull-request-error" role="alert">{pullRequestErrorMessage(t, load.error, pcName ?? undefined)}</p>}
      {view !== null && <>
        <p className="pull-request-branches">
          <span className="pull-request-state" data-state={view.draft && view.state === "open" ? "draft" : view.state}>{stateWord}</span>
          <span className="pull-request-refs" dir="ltr"><GitBranch aria-hidden="true" />{view.head_ref} → {view.base_ref}</span>
        </p>
        <section className="pull-request-section" aria-labelledby={checksId}>
          <h3 className="pull-request-section-title" id={checksId}>{t("Checks")}
            {view.checks.length > 0 && <span className="pull-request-count">{t("{failing} failing, {pending} pending, {passed} passed", { failing: failing.toLocaleString(locale), pending: pending.toLocaleString(locale), passed: passed.toLocaleString(locale) })}</span>}
          </h3>
          {view.checks.length === 0
            ? <p className="pull-request-note">{t("No checks have run on this pull request.")}</p>
            : <ul className="pull-request-list">
              {view.checks.map((check, index) => {
                const Icon = STATE_ICON[check.state];
                const key = `check:${index}`;
                return <li key={key} className="pull-request-row" data-state={check.state}>
                  <div className="pull-request-row-main">
                    <Icon className="pull-request-check-icon" aria-hidden="true" />
                    <span className="visually-hidden">{checkStateWord(t, check.state)}</span>
                    <span className="pull-request-check-name">{check.workflow !== null && <span className="pull-request-workflow">{check.workflow} / </span>}{check.name}</span>
                    {check.url !== null && <a className="icon-button pull-request-link" href={check.url} target="_blank" rel="noreferrer" aria-label={t("Open {name} on GitHub", { name: check.name })} title={t("Open on GitHub")}><ExternalLink aria-hidden="true" /></a>}
                    {check.state === "fail" && sendButton(key, () => void sendCheck(view, check, key))}
                  </div>
                  {sentNote(key)}
                </li>;
              })}
            </ul>}
        </section>
        <section className="pull-request-section" aria-labelledby={threadsId}>
          <h3 className="pull-request-section-title" id={threadsId}>{t("Open review threads")}
            {view.threads.length > 0 && <span className="pull-request-count">{view.threads.length.toLocaleString(locale)}</span>}
          </h3>
          {view.threads.length === 0
            ? <p className="pull-request-note">{t("No open review threads.")}</p>
            : <ul className="pull-request-list">
              {view.threads.map((thread, index) => {
                const key = `thread:${index}`;
                return <li key={key} className="pull-request-row pull-request-thread">
                  <div className="pull-request-row-main">
                    <MessageSquare className="pull-request-check-icon" aria-hidden="true" />
                    <span className="pull-request-thread-place" dir="ltr">{breakAfterSlashes(thread.line === null ? thread.path : `${thread.path}:${thread.line}`)}</span>
                    {thread.outdated && <span className="pull-request-tag">{t("Outdated")}</span>}
                    {thread.url !== null && <a className="icon-button pull-request-link" href={thread.url} target="_blank" rel="noreferrer" aria-label={t("Open this thread on GitHub")} title={t("Open on GitHub")}><ExternalLink aria-hidden="true" /></a>}
                    {sendButton(key, () => sendThread(view, thread, key))}
                  </div>
                  <p className="pull-request-comment">
                    {thread.author !== null && <span className="pull-request-author">@{thread.author}</span>}
                    {thread.body}
                  </p>
                  {thread.comments > 1 && <p className="pull-request-replies">{t("{count} more on GitHub", { count: (thread.comments - 1).toLocaleString(locale) })}</p>}
                  {sentNote(key)}
                </li>;
              })}
            </ul>}
          {view.threads_truncated && <p className="pull-request-note" role="status">{t("Only the first {count} threads are listed.", { count: view.threads.length.toLocaleString(locale) })}</p>}
        </section>
        {view.state === "open" && <div className="pull-request-merge">
          {blocked !== null && <p className="pull-request-note">{blocked}</p>}
          <button type="button" className="btn btn-primary" disabled={!view.mergeable} onClick={() => setConfirming(true)}>
            <GitMerge aria-hidden="true" />{mergeLabel(t, view.merge_method)}
          </button>
        </div>}
        {confirming && <ConfirmDialog title={t("Merge pull request #{number}?", { number: view.number })}
          body={t("GitHub merges {head} into {base} as it was shown here. This cannot be undone.", { head: view.head_ref, base: view.base_ref })}
          confirmLabel={mergeLabel(t, view.merge_method)}
          onConfirm={async () => {
            await mergePullRequest(target, { number: view.number, head_oid: view.head_oid, base_ref: view.base_ref, method: view.merge_method });
            setConfirming(false);
            read();
          }}
          onClose={() => setConfirming(false)} />}
      </>}
    </div>
  );
}

/** A path that wraps only after a `/` on a narrow screen, so a file name is never split. */
function breakAfterSlashes(path: string): ReactNode[] {
  return path.split("/").flatMap((part, index, parts) => index === parts.length - 1 ? [part] : [`${part}/`, <wbr key={index} />]);
}

function checkStateWord(t: ReturnType<typeof useT>, state: PullRequestCheckState): string {
  switch (state) {
    case "pass": return t("Passed");
    case "fail": return t("Failed");
    case "pending": return t("Pending");
    case "skipped": return t("Skipped");
    case "neutral": return t("Neutral");
  }
}
