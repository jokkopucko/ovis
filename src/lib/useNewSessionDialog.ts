import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionHistoryAgent } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import type { NewTabTarget } from "../components/NewSessionDialog.tsx";
import type { WorktreeRequest } from "../components/WorktreeDialog.tsx";
import type { CreateDraft } from "./deepLink.ts";
import { useRecentResumes } from "./useRecentResumes.ts";
import { forgetSessionHistoryProbesOfPcsAway } from "./useSessionHistoryOffered.ts";

export function useNewSessionMachine() {
  const [newSessionMachineId, setNewSessionMachineId] = useState("local");
  return { newSessionMachineId, setNewSessionMachineId };
}

export function useNewSessionState({ initialLink, watching = false }: { initialLink: { create?: CreateDraft | null } | null; watching?: boolean }) {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // the New workspace dialog in the address (lib/deepLink.ts): the fields a link filled for this
  // opening, and what the fields say now
  const [newPrefill, setNewPrefill] = useState<Omit<CreateDraft, "kind"> | null>(null);
  const [newFields, setNewFields] = useState<Omit<CreateDraft, "kind"> | null>(null);
  // a link to the dialog, opened once the PCs are in (a tab, once its workspace is found)
  const pendingCreate = useRef<CreateDraft | null>(initialLink?.create ?? null);
  // the dialog makes a tab in this workspace instead of a workspace, while set
  const [newTab, setNewTab] = useState<NewTabTarget | null>(null);
  // the earlier sessions of a workspace's folder (components/SessionHistory.tsx), while open
  const [sessionHistory, setSessionHistory] = useState<{ machineId: string; workspaceId: string; agent: SessionHistoryAgent; paneId: string | null; askingPaneId: string | null; selectedPaneId: string | null } | null>(null);
  // the palette's New worktree / Open worktree… (the workspace row menu keeps its own, Sidebar), while open
  const [worktreeFor, setWorktreeFor] = useState<WorktreeRequest | null>(null);
  // worktrees are not offered to a watching device: one open when this device turns into one closes
  useEffect(() => { if (watching) setWorktreeFor(null); }, [watching]);
  return { newSessionOpen, setNewSessionOpen, newPrefill, setNewPrefill, newFields, setNewFields, pendingCreate, newTab, setNewTab, sessionHistory, setSessionHistory, worktreeFor, setWorktreeFor };
}

export function useSessionHistoryList({ machines, sessionHistory, setSessionHistory, setNewSessionOpen, setNewPrefill, setNewFields }: {
  machines: Machine[];
  sessionHistory: { machineId: string; workspaceId: string; agent: SessionHistoryAgent; paneId: string | null; askingPaneId: string | null; selectedPaneId: string | null } | null;
  setSessionHistory: (value: { machineId: string; workspaceId: string; agent: SessionHistoryAgent; paneId: string | null; askingPaneId: string | null; selectedPaneId: string | null } | null) => void;
  setNewSessionOpen: (value: boolean) => void;
  setNewPrefill: (value: Omit<CreateDraft, "kind"> | null) => void;
  setNewFields: (value: Omit<CreateDraft, "kind"> | null) => void;
}) {
  const closeNewSession = useCallback(() => { setNewSessionOpen(false); setNewPrefill(null); setNewFields(null); }, []);
  const closeSessionHistory = useCallback(() => setSessionHistory(null), []);
  // the Resumes of a moment ago, kept across the list's openings until herdr reports their panes' sessions
  const { standing: recentResumes, remember: rememberResume } = useRecentResumes(machines);
  // the PCs' states are owned here: a PC away loses its cached answer to whether it lists sessions,
  // whether or not a pane or menu of it is mounted, so it is asked again once it is back
  useEffect(() => { forgetSessionHistoryProbesOfPcsAway(machines); }, [machines]);
  // the workspace the open session list is of, as its PC's roster has it now; the list leaves with the workspace
  const sessionHistoryWorkspace = useMemo(() => {
    if (sessionHistory === null) return null;
    const roster = machines.find((m) => m.id === sessionHistory.machineId)?.snapshot;
    const workspace = roster?.workspaces.find((candidate) => candidate.workspace_id === sessionHistory.workspaceId);
    const tabNumber = (tabId: string) => roster?.tabs.find((tab) => tab.tab_id === tabId)?.number ?? Number.MAX_SAFE_INTEGER;
    return roster && workspace ? { workspace, panes: [...roster.panes].sort((one, other) => tabNumber(one.tab_id) - tabNumber(other.tab_id)) } : null;
  }, [machines, sessionHistory]);
  useEffect(() => { if (sessionHistory !== null && sessionHistoryWorkspace === null) setSessionHistory(null); }, [sessionHistory, sessionHistoryWorkspace]);
  return { closeNewSession, closeSessionHistory, recentResumes, rememberResume, sessionHistoryWorkspace };
}
