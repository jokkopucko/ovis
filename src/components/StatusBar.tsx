/**
 * The pane column's bottom line from 769px, as the Herdr app's status bar (herdr-app
 * defaults/mods/workspace-status, Apache-2.0, THIRD_PARTY_NOTICES.md): where the open pane is (PC,
 * workspace, folder) and its branch on the left; a watching device's View only, the jump to the next
 * session waiting for you and the connection on the right. The header's one row keeps only the tabs
 * and their tools.
 */
import { CircleHelp, GitBranch, Monitor } from "lucide-react";

import "./StatusBar.css";

import { useT } from "../lib/i18n.ts";
import { DETACHED, usePaneBranch } from "../lib/paneBranch.ts";

export interface StatusBarProps {
  machineId: string;
  workspaceId: string;
  machine: string;
  place: string;
  path: string | null;
  session: string | null;
  watching: boolean;
  waiting: number;
  onNextWaiting: (() => void) | null;
  /** live, reconnecting (lost after it was up), connected (back, for a moment: lib/headerConnection.ts) or lost */
  connection: "live" | "reconnecting" | "connected" | "lost";
  connectionWord: string;
}

export function StatusBar({ machineId, workspaceId, machine, place, path, session, watching, waiting, onNextWaiting, connection, connectionWord }: StatusBarProps) {
  const t = useT();
  const branch = usePaneBranch(machineId, workspaceId);
  return (
    <footer className="status-bar">
      <span className="status-bar-item status-bar-place" title={path ?? undefined}>
        <Monitor aria-hidden="true" />
        <span className="status-bar-text"><span className="machine-context-name">{machine}</span> › {place}</span>
      </span>
      {branch !== null && <span className="status-bar-item">
        <GitBranch aria-hidden="true" />
        <span className="status-bar-text">{branch === DETACHED ? t("Detached HEAD") : branch}</span>
      </span>}
      {session !== null && <span className="status-bar-item status-bar-text">{session}</span>}
      <span className="status-bar-end">
        {watching && <span className="status-bar-item status-bar-watch">{t("View only")}</span>}
        {/* with no other session to open it stays a button (aria-disabled, not disabled), so the press that
            opened the last one does not drop the keyboard's focus */}
        {waiting > 0 && <button type="button" className="status-bar-item status-bar-waiting" aria-disabled={onNextWaiting === null || undefined} onClick={() => onNextWaiting?.()}
          title={t("Open the next session waiting for you")}>
          <CircleHelp aria-hidden="true" />
          {t("{count} waiting for you", { count: waiting })}
        </button>}
        <span className={`status-bar-item status-bar-conn${connection === "reconnecting" || connection === "lost" ? " is-lost" : ""}`} data-state={connection}>
          <span className="status-bar-dot" aria-hidden="true" />
          {connectionWord}
        </span>
      </span>
    </footer>
  );
}
