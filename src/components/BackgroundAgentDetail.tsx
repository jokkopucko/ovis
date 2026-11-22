import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleDot, RefreshCw, X } from "lucide-react";

import "./BackgroundAgentDetail.css";

import { ApiError, routeMissing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import type { OmoTask, PaneBackgroundAgentDetail } from "../../shared/protocol.ts";

type Failure = "update" | "unsupported" | "missing" | "changed" | "offline" | "unavailable" | "error";

const failureOf = (error: unknown): Failure => {
  if (routeMissing(error)) return "update";
  if (!(error instanceof ApiError)) return "error";
  if (error.status === 501) return "unsupported";
  if (error.status === 404) return "missing";
  if (error.status === 409) return "changed";
  if (error.code === "machine_offline") return "offline";
  if (error.status === 503) return "unavailable";
  return "error";
};

export function BackgroundAgentDetail({ paneId, task, onClose }: { paneId: string; task: OmoTask; onClose: () => void }) {
  const t = useT();
  const id = useId();
  const { fetchPaneBackgroundAgent } = useMachineApi();
  const supported = task.detail_kind === "claude-subagent" || task.detail_kind === "opencode-subagent";
  const [detail, setDetail] = useState<PaneBackgroundAgentDetail | null>(null);
  const [loading, setLoading] = useState(supported);
  const [failure, setFailure] = useState<Failure | null>(supported ? null : task.detail_kind === undefined ? "update" : "unsupported");
  const generation = useRef(0);
  // the agent's session the sheet shows, as its first answer named it: an answer of another session is
  // the pane's next session, whose agent of the same id is another agent, and is never shown here
  const session = useRef<string | null>(null);
  const load = useCallback((): void => {
    const mine = ++generation.current;
    setLoading(true);
    fetchPaneBackgroundAgent(paneId, task.id).then(
      (next) => {
        if (mine !== generation.current) return;
        if (session.current !== null && next.session_id !== session.current) { setDetail(null); setFailure("changed"); setLoading(false); return; }
        session.current = next.session_id;
        setDetail(next); setFailure(null); setLoading(false);
      },
      (reason: unknown) => {
        if (mine !== generation.current) return;
        const failed = failureOf(reason);
        if (failed !== "offline" && failed !== "unavailable" && failed !== "error") setDetail(null);
        setFailure(failed); setLoading(false);
      },
    );
  }, [fetchPaneBackgroundAgent, paneId, task.id]);
  useEffect(() => {
    if (supported) load();
    return () => { generation.current += 1; };
  }, [supported, load]);

  const surface = useFocusTrap<HTMLElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const notes: Record<Failure, [string, string]> = {
    update: [t("This PC's bridge does not offer this yet"), t("Update this PC's bridge to see what a running agent is doing.")],
    unsupported: [t("This PC can't show details for this task"), t("Only a running Claude Code or OpenCode subagent's work can be opened here.")],
    missing: [t("The agent is no longer in this pane's session"), t("It may have ended. Close this and look at the task list again.")],
    changed: [t("The pane moved to another session"), t("Close this and open the task again from the list.")],
    offline: [t("This PC is disconnected"), t("Refresh once the PC is connected again.")],
    unavailable: [t("The agent's files can't be read right now"), t("Try Refresh in a moment.")],
    error: [t("Couldn't read the agent's details"), t("Try Refresh. If it keeps failing, restart Ovis on the PC.")],
  };
  const note = (lines: string[], className = "bg-agent-note", role?: "status") => <p className={className} role={role}>{lines.map((line) => <span key={line} className="bg-agent-note-line">{line}</span>)}</p>;
  const meta = [detail?.agent ?? task.category, task.model].filter((part) => part !== null).join(" · ");
  const empty = detail !== null && detail.prompt === null && detail.events.length === 0;
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={surface} className="modal bg-agent-detail" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={loading} tabIndex={-1}>
        <header className="modal-header bg-agent-detail-header">
          <CircleDot className="bg-agent-detail-icon" aria-hidden="true" />
          <div className="bg-agent-detail-heading">
            <h2 className="modal-title bg-agent-detail-title" id={`${id}-title`}>{detail?.title ?? task.title}</h2>
            {meta.length > 0 && <p className="bg-agent-detail-meta">{meta}</p>}
          </div>
          {supported && <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} disabled={loading} onClick={load}><RefreshCw aria-hidden="true" /></button>}
          <button type="button" className="icon-button" aria-label={t("Close details")} title={t("Close details")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body bg-agent-detail-body" role="region" aria-labelledby={`${id}-title`} tabIndex={0}>
          {loading && detail === null && note([t("Loading…")])}
          {failure !== null && note(notes[failure], "bg-agent-note is-failure", "status")}
          {failure !== null && detail !== null && note([t("Couldn't refresh: this is what it last read")])}
          {empty && note([t("Nothing recorded yet"), t("The agent may still be starting. Try Refresh in a moment.")])}
          {detail?.truncated === true && note([t("The agent wrote more than this view reads."), t("The middle part is left out.")])}
          {detail?.incomplete === true && note([t("Some records couldn't be read and are left out")])}
          {detail?.prompt !== null && detail?.prompt !== undefined && <section className="bg-agent-section">
            <h3 className="bg-agent-heading">{t("Prompt")}</h3>
            <p className="bg-agent-text">{detail.prompt}</p>
          </section>}
          {detail !== null && detail.events.length > 0 && <section className="bg-agent-section">
            <h3 className="bg-agent-heading">{t("Work so far")}</h3>
            <ol className="bg-agent-events">
              {detail.events.map((event, index) => {
                if (event.kind === "text") return <li key={index} className="bg-agent-event is-text"><p className="bg-agent-text">{event.text}</p></li>;
                const space = event.text.indexOf(" ");
                const name = space === -1 ? event.text : event.text.slice(0, space);
                const args = space === -1 ? "" : event.text.slice(space + 1);
                return <li key={index} className="bg-agent-event is-tool">
                  <span className="bg-agent-tool-name">{name}</span>
                  {args.length > 0 && args !== "{}" && <code className="bg-agent-tool-args">{args}</code>}
                </li>;
              })}
            </ol>
          </section>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
