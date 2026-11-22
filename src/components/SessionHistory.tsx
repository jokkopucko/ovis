/**
 * A row whose resume syntax is not verified is listed with no button. A Claude row is the session in the
 * store of the pane the list was asked for from (`sourcePaneId`): its Resume goes to POST
 * /api/sessions/resume, which starts it in that store or names the pane already showing it there;
 * a store that changed since the list is read again with its rows held in place and the focus kept
 * on the row that asked, and a bridge that gives no source (an older one, or a store it cannot
 * choose again) offers no Resume rather than one in another store.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import "./SessionHistory.css";
import { AgentPicker } from "./AgentPicker.tsx";
import type { AgentKind, HerdrPane, SessionHistoryAgent, SessionHistoryResponse, SessionHistoryRow, TabCreated, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError, routeMissing } from "../lib/api.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { claudeResumeRequest, inFlightGuard, paneShowingRow, recentlyResumedPane, resumeTabRequest, rowKey, rowStore, sessionHistoryAgent, sessionHistorySourcePane, sessionRowTime, standingResume, type RecentResume } from "../lib/sessionHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { readSessionHistory } from "../lib/sessionHistoryRetry.ts";

interface Props {
  workspace: WorkspaceInfo;
  machineName?: string;
  panes: readonly HerdrPane[];
  agent: SessionHistoryAgent;
  sourcePaneId?: string | null;
  askingPaneId?: string | null;
  selectedPaneId?: string | null;
  recent?: readonly RecentResume[];
  onClose: () => void;
  /** browser selection only: herdr's focus stays where it is */
  onSelectPane: (paneId: string) => void;
  onResumed: (opened: TabCreated, session: { agent: SessionHistoryAgent; id: string; store: string }) => void;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

const NO_RECENT: readonly RecentResume[] = [];

export function SessionHistory({ workspace, machineName, panes, agent: firstAgent, sourcePaneId: firstSourcePaneId = null, askingPaneId = firstSourcePaneId, selectedPaneId = null, recent = NO_RECENT, onClose, onSelectPane, onResumed }: Props) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const machineId = useMachineId();
  const { createTab, fetchAgentKinds, fetchSessionHistory, resumeSession } = useMachineApi();
  const [agent, setAgent] = useState<SessionHistoryAgent>(firstAgent);
  const sourcePaneId = sessionHistorySourcePane(agent, panes, { workspaceId: workspace.workspace_id, askingPaneId, selectedPaneId });
  const [kinds, setKinds] = useState<AgentKind[]>([]);
  const [answer, setAnswer] = useState<SessionHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRetry, setBusyRetry] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [relisted, setRelisted] = useState(false);
  const [relisting, setRelisting] = useState(false);
  const keepRows = useRef(false);
  const refocus = useRef<string | null>(null);
  const guard = useRef(inFlightGuard());
  const refusal = useCallback((reason: unknown): string => {
    if (routeMissing(reason)) return t("This PC's bridge does not offer this yet");
    if (reason instanceof ApiError && reason.code === "claude_store_unknown") return t("Which Claude store this pane uses can't be told, so its sessions aren't listed. Check that one Claude runs in this pane and its store folder exists, then open the list again.");
    if (reason instanceof ApiError && reason.code === "launch_unsupported") return t("This PC can't start this session in the store it was listed from");
    if (reason instanceof ApiError && reason.code === "stale_source") return t("The source pane or its Claude store changed. Open the list again.");
    if (reason instanceof ApiError && reason.code === "launch_store_changed") return t("A shell startup file set another Claude store, so the new tab was closed.");
    if (reason instanceof ApiError && reason.code === "launch_store_unknown") return t("The new tab's Claude store couldn't be confirmed, so the tab was closed.");
    if (reason instanceof ApiError && reason.code === "resume_timed_out") return t("Resuming took too long, so it was stopped. A tab it started will be closed. Try again.");
    if (reason instanceof ApiError && reason.code === "resume_in_progress") return t("This session is still being resumed. Try again in a moment.");
    return said(reason);
  }, [t]);
  const surface = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const picker = useRef<HTMLButtonElement>(null);
  useSheetSwipe(surface, pending ? null : onClose);
  usePhoneSheetBack(() => { if (pending) return false; onClose(); });
  const opener = useRef<HTMLElement | null>(null);
  const placed = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // the dialog holds the focus from its first paint: an Escape pressed at once closes it rather
    // than going to the message box it was opened from
    picker.current?.focus({ preventScroll: true });
    placed.current = picker.current;
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const again = refocus.current;
      refocus.current = null;
      const row = again === null ? null : list.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(again)}"] button:not(:disabled)`);
      if (row) { row.focus(); placed.current = row; return; }
      const active = document.activeElement;
      if (surface.current?.contains(active) && active !== placed.current) return;
      if (picker.current?.getAttribute("aria-expanded") === "true") return;
      const target = list.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? picker.current;
      target?.focus();
      placed.current = target ?? null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [answer]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const active = document.activeElement;
      if (active && active !== document.body && !surface.current?.contains(active)) return;
      if (picker.current?.getAttribute("aria-expanded") === "true") return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);
  useEffect(() => {
    let cancelled = false;
    fetchAgentKinds().then((next) => { if (!cancelled) setKinds(next); }, () => { /* the first agent alone is offered */ });
    return () => { cancelled = true; };
  }, [fetchAgentKinds]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    if (!keepRows.current) setAnswer(null);
    keepRows.current = false;
    setError(null);
    setBusyRetry(false);
    readSessionHistory(() => fetchSessionHistory(workspace.workspace_id, agent, sourcePaneId), agent, { signal: controller.signal }).then(
      (listing) => { if (!cancelled) { setAnswer(listing); setRelisting(false); } },
      (reason: unknown) => { if (!cancelled) {
        setAnswer(null);
        setError(refusal(reason));
        setBusyRetry(agent === "pi" && reason instanceof ApiError && reason.status === 503 && reason.code === "session_history_busy");
        setRelisting(false);
      } },
    );
    return () => { cancelled = true; controller.abort(); };
  }, [agent, fetchSessionHistory, reload, sourcePaneId, refusal, workspace.workspace_id]);
  useEffect(() => { setRelisted(false); }, [agent]);
  const options = useMemo(() => {
    const listed = kinds.flatMap((kind) => { const named = sessionHistoryAgent(kind.kind); return named === null ? [] : [{ kind: named, label: kind.label }]; });
    return listed.some((option) => option.kind === firstAgent) ? listed : [{ kind: firstAgent, label: firstAgent }, ...listed];
  }, [firstAgent, kinds]);
  const agentLabel = options.find((option) => option.kind === agent)?.label ?? agent;
  const now = useMemo(() => Date.now(), [answer]);
  const failed = (row: SessionHistoryRow, reason: unknown): void => {
    setPending(null);
    // the pane's Claude is on another store now, or gone: its rows are read again, never resumed elsewhere
    if (reason instanceof ApiError && reason.status === 409 && reason.code === "stale_source") {
      keepRows.current = true;
      refocus.current = row.id;
      setRelisting(true);
      setRelisted(true);
      setReload((count) => count + 1);
      return;
    }
    setError(refusal(reason));
  };
  const resume = (row: SessionHistoryRow): void => {
    const store = rowStore(row);
    let started: Promise<TabCreated | { opened: string }> | null;
    if (agent === "claude") {
      const request = claudeResumeRequest(row, workspace.workspace_id);
      if (request === null) return;
      started = guard.current.run(() => resumeSession(request).then((answer) => answer.action === "opened" ? { opened: answer.pane_id } : { workspace_id: answer.workspace_id, pane_id: answer.pane_id, agent_started: answer.agent_started, ...(answer.error ? { error: answer.error } : {}) }));
    } else {
      const request = resumeTabRequest(row, workspace.workspace_id, answer?.cwd ?? null);
      if (request === null) return;
      started = guard.current.run(() => createTab(request));
    }
    if (started === null) return;
    setPending(rowKey(row));
    setError(null);
    setRelisted(false);
    started.then(
      (opened) => {
        if ("opened" in opened) { setPending(null); onSelectPane(opened.opened); return; }
        if (opened.agent_started === false && opened.error) { setPending(null); setError(opened.error.message); return; }
        onResumed(opened, { agent, id: row.id, store });
      },
      (reason: unknown) => failed(row, reason),
    );
  };
  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || !surface.current) return;
    const stops = [...surface.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    if (stops.length === 0) return;
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index < 0 || index === stops.length - 1 ? 0 : index + 1);
    event.preventDefault();
    stops[next]?.focus();
  };
  const moveAlongRows = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !list.current) return;
    const buttons = [...list.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    event.preventDefault();
    buttons[next]?.focus();
  };
  const rows = answer?.sessions ?? null;
  const momentAgo = Date.now();
  const dialogTitle = t("Earlier sessions · {name}", { name: `${workspace.label} · ${machineName ?? machineId}` });
  return createPortal(
    <div className="modal-scrim" onMouseDown={closeFromScrim}>
      <div ref={surface} className="modal session-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`} title={dialogTitle}>{dialogTitle}</h2>
          <button type="button" className="icon-button" aria-label={t("Close session list")} title={t("Close session list")} disabled={pending !== null} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="field session-agent">
            <span className="field-label" id={`${id}-agent`}>{t("Agent")}</span>
            <AgentPicker ref={picker} agents={options} value={agent} shell={false} disabled={pending !== null || relisting} labelledBy={`${id}-agent`} onChange={(kind) => setAgent(kind as SessionHistoryAgent)} />
            {answer && <span className="field-hint session-folder">{t("Sessions started in {folder}", { folder: "\u0000" }).split("\u0000").map((part, index) => index === 0 ? <span key="before">{part}</span> : <span key="after"><code>{answer.cwd}</code>{part}</span>)}</span>}
          </div>
          {rows === null && !error ? (
            <p className="field-hint" role="status">{t("Reading sessions…")}</p>
          ) : rows && rows.length === 0 ? (
            <p className="field-hint session-empty">{t("No earlier {agent} sessions in this folder. Choose another agent.", { agent: agentLabel })}</p>
          ) : rows && (
            <ul ref={list} className="session-list" aria-label={t("Earlier sessions")} onKeyDown={moveAlongRows}>
              {rows.map((row) => {
                const key = rowKey(row);
                const title = row.title ?? row.firstMessage ?? row.id;
                const detail = row.title !== null ? row.firstMessage : null;
                const when = sessionRowTime(row, now, locale, t);
                const resumed = standingResume(recent, panes, machineId, workspace.workspace_id, agent, row.id, momentAgo, rowStore(row));
                const shown = paneShowingRow(panes, workspace.workspace_id, agent, row) ?? recentlyResumedPane(recent, panes, machineId, workspace.workspace_id, agent, row.id, momentAgo, rowStore(row));
                const withheld = resumed !== undefined && shown === undefined;
                const resumable = row.resume !== null && row.resume.argv.length > 0;
                // a Claude row its bridge bound to no store: no Resume that could start it in another
                const unbound = resumable && agent === "claude" && claudeResumeRequest(row, workspace.workspace_id) === null;
                return (
                  <li key={key} data-session-id={row.id} className={`session-row${pending === key ? " is-pending" : ""}`} aria-label={when ? `${title} · ${when.label}` : title}>
                    <span className="session-copy">
                      <span className={`session-title${row.title === null && row.firstMessage === null ? " session-id" : ""}`}>{title}</span>
                      {detail !== null && <span className="session-detail">{detail}</span>}
                    </span>
                    <span className="session-meta">
                      {when && <time className="session-time" dateTime={row.updatedAt} title={when.title}>{when.label}</time>}
                      {shown || withheld ? (
                        <span className="session-actions">
                          <span className="pill">{t("Already open")}</span>
                          <button type="button" className="btn session-action" disabled={pending !== null || relisting || shown === undefined} aria-label={t("Open the pane showing {title}", { title })} onClick={() => { if (shown) onSelectPane(shown.pane_id); }}>{t("Open")}</button>
                        </span>
                      ) : unbound ? (
                        <span className="pill" title={t("This PC can't start this session in the store it was listed from")}>{t("Resume unavailable")}</span>
                      ) : resumable && (
                        <button type="button" className="btn session-action" disabled={pending !== null || relisting} aria-label={t("Resume {title}", { title })} onClick={() => resume(row)}>{t("Resume")}</button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {/* one line kept under the rows, so none of them moves when it speaks: Resuming, Reading again, why it was read again */}
          {rows && rows.length > 0 && <p className="field-hint session-status" role="status">{pending !== null ? t("Resuming…") : relisting ? t("Reading sessions…") : relisted ? t("Claude's store changed; the list was read again.") : null}</p>}
          {error && <p className="field-hint session-error" role={busyRetry ? "status" : "alert"}>{error}</p>}
        </div>
        <footer className="modal-footer">
          {busyRetry && <button type="button" className="btn" onClick={() => setReload((count) => count + 1)}>{t("Retry")}</button>}
          <button type="button" className="btn btn-ghost" disabled={pending !== null} onClick={onClose}>{t("Cancel")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
