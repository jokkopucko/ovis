import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HerdrPane, SessionSnapshot, TabCreated } from "../shared/protocol.ts";
import type { AppActions } from "../src/lib/actions.ts";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { sessionHistoryAgent, sessionHistorySourcePane } from "../src/lib/sessionHistory.ts";
import { useRecentResumes } from "../src/lib/useRecentResumes.ts";
import { SettingsProvider } from "../src/lib/settings.ts";
import { Sidebar } from "../src/components/Sidebar.tsx";
import { SessionHistory } from "../src/components/SessionHistory.tsx";
import { CLAUDE_SHARED, SHOWN_SESSION } from "./session-history-fixture-data.ts";
import "../src/styles.css";
declare global { interface Window { qa: {
  machine: (id: string) => void; selected: string | null; resumed: TabCreated[]; historyOpen: boolean;
  reportSession: (paneId: string, id: string, agent?: string) => void;
  closePane: (paneId: string) => void;
  openHistory: (workspaceId: string, agent: string, paneId: string) => void;
  holdRoster: boolean;
  rosterCatchUp: () => void;
  watch: (watching: boolean) => void;
} } }
const pane = (id: string, workspace: string, overrides: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id: id, tab_id: `${workspace}:t1`, terminal_id: `${id}:term`, workspace_id: workspace, agent: "codex", agent_status: "idle", focused: false, revision: 1,
  cwd: `/fixture/${workspace}`, title: "codex", ...overrides,
}) as HerdrPane;
const SNAPSHOT: SessionSnapshot = {
  protocol: 22, version: "fixture", agents: [], layouts: [],
  workspaces: [
    { workspace_id: "w1", label: "fixture-folder", number: 1, active_tab_id: "w1:t1", agent_status: "idle", focused: true, pane_count: 1, tab_count: 1 },
    { workspace_id: "w2", label: "shown-folder", number: 2, active_tab_id: "w2:t1", agent_status: "idle", focused: false, pane_count: 1, tab_count: 1 },
    { workspace_id: "w3", label: "claude-folder", number: 3, active_tab_id: "w3:t1", agent_status: "idle", focused: false, pane_count: 2, tab_count: 2 },
    { workspace_id: "w4", label: "older-bridge", number: 4, active_tab_id: "w4:t1", agent_status: "idle", focused: false, pane_count: 1, tab_count: 1 },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "Tab 1", number: 1, agent_status: "idle", focused: true, pane_count: 1 },
    { tab_id: "w2:t1", workspace_id: "w2", label: "Tab 1", number: 1, agent_status: "idle", focused: false, pane_count: 1 },
    { tab_id: "w3:t1", workspace_id: "w3", label: "Tab 1", number: 1, agent_status: "idle", focused: false, pane_count: 1 },
    { tab_id: "w3:t2", workspace_id: "w3", label: "Tab 2", number: 2, agent_status: "idle", focused: false, pane_count: 1 },
    { tab_id: "w4:t1", workspace_id: "w4", label: "Tab 1", number: 1, agent_status: "idle", focused: false, pane_count: 1 },
  ],
  panes: [
    pane("p1", "w1"),
    pane("p2", "w2", { agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: SHOWN_SESSION } }),
    pane("p3", "w3", { agent: "claude", title: "claude" }),
    pane("p4", "w3", { tab_id: "w3:t2", agent: "claude", title: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: CLAUDE_SHARED } }),
    pane("p-shell", "w3", { agent: null, title: "shell" }),
    pane("p5", "w4", { agent: "claude", title: "claude" }),
  ],
};
const noop = () => {};
window.qa = { machine: () => {}, selected: null, resumed: [], historyOpen: false, reportSession: () => {}, closePane: () => {}, openHistory: () => {}, holdRoster: false, rosterCatchUp: () => {}, watch: () => {} };
function Root() {
  const [machine, setMachine] = useState("local");
  const [watching, setWatching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<{ workspaceId: string; agent: string | null; paneId: string | null; askingPaneId: string | null } | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(SNAPSHOT);
  const machines = useMemo(() => [{ id: machine, snapshot }], [machine, snapshot]);
  const { standing: recentResumes, remember: rememberResume } = useRecentResumes(machines);
  window.qa.machine = setMachine;
  window.qa.watch = setWatching;
  window.qa.selected = selected;
  window.qa.historyOpen = history !== null;
  window.qa.reportSession = (paneId, id, agent = "codex") => setSnapshot((current) => ({ ...current, panes: current.panes.map((candidate) => candidate.pane_id === paneId ? { ...candidate, agent_session: { agent, kind: "id", source: `herdr:${agent}`, value: id } } : candidate) }));
  window.qa.closePane = (paneId) => setSnapshot((current) => ({ ...current, panes: current.panes.filter((candidate) => candidate.pane_id !== paneId) }));
  const held = useRef<HerdrPane[]>([]);
  const join = (panes: HerdrPane[]) => setSnapshot((current) => ({ ...current, panes: [...current.panes, ...panes] }));
  window.qa.rosterCatchUp = () => join(held.current.splice(0));
  const actions: AppActions = {
    selectPane: setSelected, selectAdjacentPane: noop, setView: noop, toggleView: noop, focusInput: noop, scrollPage: noop, openNewSession: noop, openNewTab: noop, renameTab: noop,
    openTerminalTab: async () => {}, openSessionHistory: (target) => {
      if (target) setHistory({ workspaceId: target.workspaceId, agent: target.agent ?? null, askingPaneId: target.paneId ?? null, paneId: sessionHistorySourcePane(sessionHistoryAgent(target.agent) ?? "codex", snapshot.panes, { workspaceId: target.workspaceId, askingPaneId: target.paneId, selectedPaneId: selected }) });
    },
    openPalette: noop, agentStarted: noop, openFind: noop, openSettings: noop, openAddPc: noop, toggleSidebar: noop, openSidebarFilter: noop, toggleTheme: noop, lock: null, enableNotifications: null,
    refresh: noop, openFiles: null, splitPane: null, zoomPane: null,
  };
  window.qa.openHistory = (workspaceId, agent, paneId) => actions.openSessionHistory({ machineId: machine, workspaceId, agent, paneId, scope: "pane" });
  const workspace = history ? snapshot.workspaces.find((candidate) => candidate.workspace_id === history.workspaceId) : undefined;
  return <SettingsProvider><MachineContext.Provider value={machine}>
    <div className="sidebar-shell" style={{ width: 320, height: 600 }}>
      <Sidebar key={machine} snapshot={snapshot} online watching={watching} selectedPaneId={selected} actions={actions} />
    </div>
    {history && workspace && <SessionHistory
      workspace={workspace}
      panes={snapshot.panes}
      agent={sessionHistoryAgent(history.agent) ?? "codex"}
      sourcePaneId={history.paneId}
      askingPaneId={history.askingPaneId}
      selectedPaneId={selected}
      recent={recentResumes}
      onClose={() => setHistory(null)}
      onSelectPane={(paneId) => { setHistory(null); setSelected(paneId); }}
      onResumed={(opened, session) => {
        setHistory(null);
        window.qa.resumed.push(opened);
        if (!opened.agent_started) return;
        rememberResume({ machineId: machine, workspaceId: workspace.workspace_id, agent: session.agent, id: session.id, store: session.store, paneId: opened.pane_id });
        const made = pane(opened.pane_id, workspace.workspace_id, { agent: session.agent, agent_session: null });
        if (window.qa.holdRoster) held.current.push(made); else join([made]);
      }}
    />}
  </MachineContext.Provider></SettingsProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Root /></React.StrictMode>);
