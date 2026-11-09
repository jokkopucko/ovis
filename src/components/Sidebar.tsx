import { Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type AnimationEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Folder, FolderOpen, GitBranch, History, Layers, ListChecks, Pencil, Pin, PinOff, Plus, Terminal, Trash2, TriangleAlert, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, PaneContext, PaneInfo, PlanSummary, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { renamesWorkspace } from "../lib/layoutTargets.ts";
import { useAppLayout, useMachineApi, useMachineId, useReorderCoordinator } from "../lib/machineContext.tsx";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { usePaneLocked } from "../lib/paneLocks.ts";
import type { AppActions } from "../lib/actions.ts";
import { indicatorGlyph, knownStatus, rollupStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { WorkspaceFavicon } from "./WorkspaceFavicon.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { WorktreeDialog, type WorktreeDialogMode } from "./WorktreeDialog.tsx";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { folderName, shortPathTitle, stripPaneChrome, tabTitle, taskRowLines } from "../lib/paneName.ts";
import { useT } from "../lib/i18n.ts";
import { contextLeftPercent, formatTokens } from "../lib/compose.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { filterWorkspaceGroups, machineFilter } from "../lib/sidebarFilter.ts";
import { useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { useSettings } from "../lib/settings.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { useWorktreeBranches } from "../lib/useWorktreeBranches.ts";
import { useSessionHistoryOffered } from "../lib/useSessionHistoryOffered.ts";
import { useRepositoryWorkspaces } from "../lib/repositoryWorkspaces.ts";
import { watchTouchReorder } from "../lib/touchReorder.ts";
import { isBackgroundWorkspace, placeBlock, splitBackgroundGroups, workspaceMoves, worktreeGroups as groupWorktrees } from "../lib/workspaceOrder.ts";
import { worktreeLabel } from "../lib/worktreeName.ts";
import { lastViewedPane, rememberViewedPane } from "../lib/lastViewedPane.ts";
import { agentTabName, paneMark, sidebarAgents, workspaceAgentLabels, type SidebarAgent } from "../lib/sidebarAgents.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { publishWorkspaceRows, workspaceRows } from "../lib/adjacentTarget.ts";
import { currentSidebarPins, pinnedGroupIds, pinnedWorkspaceIds, pruneWorkspacePins, reorderWorkspacePins, setSidebarPins, splitPinnedGroups, subscribeSidebarPins, toggleSidebarPin, workspacePinKey, type WorkspaceGroup } from "../lib/sidebarPins.ts";

const ERROR_NOTE_MS = 5000;

const worktreeCollapsedKey = (machineId: string, repoKey: string) => `ovis:worktree-group-collapsed:${machineId}:${repoKey}`;
export function storedWorktreeCollapsed(machineId: string, repoKeys: string[]): Set<string> {
  const collapsed = new Set<string>();
  try {
    for (const key of repoKeys) if (localStorage.getItem(worktreeCollapsedKey(machineId, key)) === "1") collapsed.add(key);
  } catch { /* storage denied: nothing is folded */ }
  return collapsed;
}

/** the fold of a PC's background workspaces, kept on this device; it starts folded */
const backgroundFoldKey = (machineId: string) => `ovis:workspaces-background-collapsed:${machineId}`;
export function storedBackgroundFolded(machineId: string): boolean {
  try {
    return localStorage.getItem(backgroundFoldKey(machineId)) !== "0";
  } catch {
    return true;
  }
}

export { paneTitle };

/**
 * The title a row or the header shows: the user's label, else the live title minus its chrome,
 * a working directory written out shortened to its last folder (lib/paneName.ts).
 */
export function displayPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent)) || pane.pane_id;
}

/**
 * The browser tab's title for a pane: as a row's, with an agent's glyph and spinner kept, as the tab
 * has no row mark or badge beside it (omp's `π ⠋`, #2568).
 */
export function tabPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || tabTitle(paneTitle(pane), pane.agent) || pane.pane_id;
}

/**
 * The title an alert names a pane by: as a row's, with the folder Codex adds after its thread
 * kept. A notification is read away from the row that says where the pane is.
 */
export function alertPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent, true)) || pane.pane_id;
}

/** herdr could not bring this pane back after a restart (0.9.3+ `restore_error`): a warning in the status cell, its reason on hover. */
export function RestoreErrorBadge({ reason }: { reason: string }) {
  const t = useT();
  const label = t("NOT RESTORED");
  return (
    <span className="badge badge-restore-error sidebar-status" data-status="restore-error" role="status" aria-label={label} title={`${label} — ${reason}`}>
      <TriangleAlert aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/** Every breathing dot or glyph keeps the document clock's phase, so a row that starts working breathes in step with the rest. */
function alignBreath(event: AnimationEvent<HTMLSpanElement>) {
  if (event.animationName !== "sidebar-breathe") return;
  for (const animation of event.currentTarget.getAnimations()) animation.startTime = 0;
}

/** `detail`: what the agent itself said of the state (a blocked agent's reason), after the state's words */
export function StatusBadge({ status, compact = false, detail = null }: { status?: AgentStatus; compact?: boolean; detail?: string | null }) {
  const t = useT();
  const { settings } = useSettings();
  const value = knownStatus(status);
  const label = t(STATUS_WORD[value]);
  // the description names the state in words a reader knows (G-020): "waiting" is said whole, and a state nobody
  // reported (an agent that said nothing yet, a PC that is away) is said to be unknown, not read as a dash
  const stateWords = value === "waiting" ? t("Agent waiting on background work") : value === "unknown" ? t("Agent state unknown") : t("Agent {status}", { status: label });
  const description = detail ? `${stateWords} — ${detail}` : stateWords;
  // classic (the default): a compact cell draws only the states that ask for a look: a red question
  // mark while the agent waits for an answer, a green dot once it has finished and was not looked
  // at, a working-coloured dot that breathes while it runs, a working-coloured ring held still while
  // its turn waits on background work. Ready and unknown keep the cell, its label and its tooltip.
  // Dots or Symbols: herdr's TUI glyph for every state, in herdr's color (lib/status.ts, Sidebar.css)
  const indicators = settings.statusIndicators;
  const dot = value === "working" || value === "done" || value === "waiting";
  return (
    <span
      className={`badge badge-${value}${compact ? " sidebar-status" : ""}`}
      data-status={value}
      role={compact ? "status" : undefined}
      aria-label={compact ? description : undefined}
      title={description}
    >
      {compact && indicators !== "classic" && <span className="sidebar-status-glyph" aria-hidden="true" onAnimationStart={value === "working" ? alignBreath : undefined}>{indicatorGlyph(value, indicators)}</span>}
      {compact && indicators === "classic" && value === "blocked" && <span className="sidebar-status-mark" aria-hidden="true">?</span>}
      {compact && indicators === "classic" && dot && <span className="sidebar-status-dot" aria-hidden="true" onAnimationStart={value === "working" ? alignBreath : undefined} />}
      <span className={compact ? "visually-hidden" : undefined}>{label}</span>
    </span>
  );
}

/**
 * Background tasks an agent started that still run (OmO's `task` children): the main turn can be
 * done while they work, and they wake the session by themselves. A quiet count beside the state,
 * not a state of its own: DONE stays the moment the agent answered.
 */
export function BackgroundBadge({ count }: { count?: number }) {
  const t = useT();
  if (!count || count <= 0) return null;
  const label = t("Background tasks running: {count}", { count });
  return (
    <span className="background-count" title={label} aria-label={label} data-testid="background-tasks">
      <Layers aria-hidden="true" />{count}
    </span>
  );
}

/** How far the pane's plan has got: a count beside the state word, quiet once every step is done. */
export function PlanBadge({ plan }: { plan?: PlanSummary }) {
  const t = useT();
  if (!plan || plan.total <= 0) return null;
  const label = t("Plan: {done} of {total} done", { done: plan.done, total: plan.total });
  return (
    <span className={`plan-count${plan.done === plan.total ? " is-done" : ""}`} title={plan.current ? `${label} · ${plan.current}` : label} aria-label={label} data-testid="plan-progress">
      <ListChecks aria-hidden="true" />{plan.done}/{plan.total}
    </span>
  );
}

/**
 * What is left of the pane's context: the composer's ring, its words and its threshold (red at 20%
 * left or less), so the two never disagree; a window nothing names draws nothing, as the ring does.
 */
export function ContextBadge({ context }: { context?: PaneContext | undefined }) {
  const t = useT();
  const left = context ? contextLeftPercent(context) : null;
  if (!context || left === null || context.window === null) return null;
  const label = `${t("Context {percent}% left", { percent: left })} · ${t("{used} of {window} tokens", { used: formatTokens(context.used), window: formatTokens(context.window) })}`;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className={`context-count${left <= 20 ? " is-low" : ""}`} title={label} aria-label={label} data-testid="context-left">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="context-count-track" cx="8" cy="8" r={radius} />
        <circle className="context-count-used" cx="8" cy="8" r={radius}
          strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>{left}%
    </span>
  );
}

/**
 * A worktree workspace's name without what herdr adds to it: the `worktree-` prefix and the four-digit hash after
 * it, only when both are there (`worktree-brave-valley-7fc6`); any other name is kept whole.
 */
export function compactWorktreeName(label: string): string {
  const generated = /^worktree-(.+)-[0-9a-f]{4}$/.exec(label);
  return generated ? generated[1]! : label;
}

/**
 * Whether a branch only repeats a workspace's name: the same text, or for a worktree herdr named
 * (`worktree-brave-valley-7fc6`) its branch `worktree/brave-valley-7fc6` or `brave-valley`, herdr's prefix and hash aside.
 */
export function sameName(branch: string, name: string): boolean {
  if (branch === name) return true;
  const short = compactWorktreeName(name);
  return short !== name && branch.replace(/^worktree[-/]/, "").replace(/-[0-9a-f]{4}$/, "") === short;
}

/** the kind-of-change prefixes a branch drops on a compact row; any other prefix (`team-a/`) says something and stays */
const BRANCH_KIND = /^(?:feat|feature|fix|bugfix|hotfix|chore|docs|refactor|perf|test|tests|ci|build|style|release)\//;

/** The branch a compact row says at its end: none for the default branch, and without a `feat/`-style prefix. */
export function compactBranch(branch: string | null): string | null {
  if (branch === null || branch === "main" || branch === "master") return null;
  return branch.replace(BRANCH_KIND, "") || branch;
}

function cwdBasename(cwd: string | null | undefined): string {
  return cwd ? folderName(cwd) : "unknown directory";
}

interface InlineError {
  workspaceId?: string;
  message: string;
  detail: string | null;
}

/**
 * A workspace right-click opens herdr's workspace menu at the pointer without moving focus.
 * Dismissal restores the prior input. A name editor keeps the browser's paste menu.
 * A finger's long press is left alone: it picks a workspace row up to be moved (lib/touchReorder.ts),
 * and the ⋯ is always there on touch. A desktop draws no ⋯ (Sidebar.css): the row itself anchors the menu.
 */
export function onRowContextMenu(event: MouseEvent<HTMLElement>, toggle: (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null) => void): void {
  if ((event.target as HTMLElement).closest("input")) return;
  // Chrome and Safari say what pressed; Firefox does not, so there the device's main pointer decides
  const pointer = (event.nativeEvent as PointerEvent).pointerType;
  if (pointer ? pointer === "touch" : window.matchMedia("(pointer: coarse)").matches) return;
  const toggleButton = event.currentTarget.querySelector<HTMLElement>(".row-menu-toggle");
  if (!toggleButton) return;
  const anchor = toggleButton.getClientRects().length > 0 ? toggleButton : event.currentTarget;
  event.preventDefault();
  const box = anchor.getBoundingClientRect();
  toggle(anchor, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom }, document.activeElement instanceof HTMLElement ? document.activeElement : null);
}

/** The row whose ⋯ menu is open: a workspace, seen through the pane its row shows. */
interface MenuState { anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null; workspace: WorkspaceInfo; title: string; place: string }
/**
 * What a close takes, read from a roster: the workspace, with a group close the repository's other
 * workspaces as herdr finds them when it closes, and every pane in them by id.
 */
interface CloseScope { workspaceId: string; group: boolean; workspaces: string[]; panes: string[] }

function closeScope(shown: SessionSnapshot | null, workspaceId: string, group: boolean): CloseScope | null {
  const head = shown?.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  if (!shown || !head) return null;
  const repoKey = head.worktree?.repo_key;
  const others = group && repoKey !== undefined ? shown.workspaces.filter((candidate) => candidate.workspace_id !== workspaceId && candidate.worktree?.repo_key === repoKey) : [];
  const workspaces = [workspaceId, ...others.map((candidate) => candidate.workspace_id)].sort();
  const panes = shown.panes.filter((pane) => workspaces.includes(pane.workspace_id)).map((pane) => pane.pane_id).sort();
  return { workspaceId, group, workspaces, panes };
}

interface ConfirmState { title: string; body: string; action?: string; run: () => Promise<void>;
  /** what the action closes as the user agreed to it (closeScope): it goes once the roster or a lock says otherwise */
  closes?: CloseScope; escalation?: { label: string; code: string; run: () => Promise<void> } }

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  online: boolean;
  selectedPaneId: string | null;
  actions: AppActions;
  /** this device only watches: the row's menu offers no earlier sessions, which the server refuses it */
  watching?: boolean;
}

/**
 * Spaces follow herdr's workspace roster. A workspace opens its current pane; tabs and split
 * panes are navigated through the tab strip, while Agents is an independent API-backed list.
 */
export function Sidebar({ snapshot, online, selectedPaneId, actions, watching = false }: SidebarProps) {
  const t = useT();
  const { settings } = useSettings();
  const twoLine = settings.sidebarRows === "two";
  // Settings > Appearance > Agents under workspaces: each workspace's agents hang under its row (#773)
  const agentTree = settings.sidebarAgentTree;
  const machineId = useMachineId();
  const pressPane = useContext(PanePressContext);
  // what the PC's herdr answers for its workspaces (lib/machineContext.tsx): herdr-core has no worktrees, and
  // renames and reorders them only where Ovis keeps its layout
  const { rename: renameOffered, arrange, worktrees: worktreesOffered } = useAppLayout();
  const activity = useSidebarActivity();
  const { closeWorkspace, listWorktrees, moveWorkspace, removeWorktree, renameWorkspace } = useMachineApi();
  // the row menu's Earlier sessions needs the PC's bridge to list them (lib/useSessionHistoryOffered.ts)
  const historyOffered = useSessionHistoryOffered(online);
  // the roster's wait is a live region in the list from its first render, clipped while empty (never
  // display: none); its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(snapshot ? null : t("Loading workspaces…"));
  // the unmarked workspaces git answers for: a repository's folder, where the first worktree starts
  // (lib/repositoryWorkspaces.ts, shared with the palette)
  const { repositoryWorkspaces, notCheckout } = useRepositoryWorkspaces({ machineId, snapshot, online, watching, offered: worktreesOffered, listWorktrees });
  const { branches, rememberOpened } = useWorktreeBranches(snapshot, online, true, repositoryWorkspaces, watching, notCheckout);
  // the sidebar's filter (lib/sidebarFilter.ts): which rows stay, which are context; it learns the branch
  // each row says from here, since the inventory is this roster's. What it last said outlives a fold of the
  // PC (which unmounts this roster), so a branch stays findable on a PC drawn folded
  const { filter, reportBranches } = useSidebarFilter();
  const filtered = machineFilter(filter, machineId);
  useEffect(() => {
    reportBranches(machineId, new Map([...branches].flatMap(([id, known]) => known.branch ? [[id, known.branch] as const] : [])));
  }, [branches, machineId, reportBranches]);
  // while a filter is on, a worktree fold is the filter's to hold: a match opens it, and its caret folds or
  // opens it for the filter's time only, the saved fold untouched (lib/sidebarFilter.ts)
  const [filterFolds, setFilterFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const filtering = filtered !== null;
  // Settings → Background workspaces apart: workspaces tagged role=background stand after the others, under
  // a heading that folds them (kept per PC on this device); under a filter it opens, for the filter's time only
  const backgroundApart = settings.sidebarBackgroundWorkspaces;
  const [backgroundCollapsed, setBackgroundCollapsed] = useState(() => storedBackgroundFolded(machineId));
  const [backgroundFilterFold, setBackgroundFilterFold] = useState<boolean | null>(null);
  useEffect(() => {
    if (filtering) return;
    setFilterFolds((current) => current.size === 0 ? current : new Map());
    setBackgroundFilterFold(null);
  }, [filtering]);
  const backgroundFolded = filtering ? backgroundFilterFold ?? false : backgroundCollapsed;
  const toggleBackground = (): void => {
    if (filtering) { setBackgroundFilterFold(!backgroundFolded); return; }
    setBackgroundCollapsed(!backgroundCollapsed);
    try { localStorage.setItem(backgroundFoldKey(machineId), backgroundCollapsed ? "0" : "1"); } catch { /* storage denied: this page keeps it */ }
  };
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // a workspace holding a locked pinned agent (lib/paneLocks.ts) is closed or deleted from no menu here
  const paneLocked = usePaneLocked(machineId);
  const holdsLock = (workspaceIds: readonly string[]): boolean => snapshot?.panes.some((pane) => workspaceIds.includes(pane.workspace_id) && paneLocked(pane.pane_id)) === true;
  // a close goes only over what the user agreed to: read again at each render, the one a confirm's click lands
  // in too, and any workspace or pane come or gone, or a lock landed (from another browser), takes the
  // confirmation away unsent
  const stillAgreed = (agreed: CloseScope): boolean => {
    const now = closeScope(snapshot, agreed.workspaceId, agreed.group);
    return now !== null && JSON.stringify([now.workspaces, now.panes]) === JSON.stringify([agreed.workspaces, agreed.panes]) && !holdsLock(now.workspaces);
  };
  if (confirm?.closes && !stillAgreed(confirm.closes)) setConfirm(null);
  const [worktreeDialog, setWorktreeDialog] = useState<{ mode: WorktreeDialogMode; workspace: WorkspaceInfo } | null>(null);
  // worktrees are not offered to a watching device: one open when this device turns into one closes
  useEffect(() => { if (watching) setWorktreeDialog(null); }, [watching]);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  // the order App's coordinator draws: herdr's, or a drag's until a roster read after its moves comes
  const reorder = useReorderCoordinator();
  const orderVersion = useSyncExternalStore(reorder.subscribe, reorder.version, reorder.version);
  const workspaceOrder = useMemo(() => snapshot ? reorder.order(machineId, snapshot.workspaces.map((workspace) => workspace.workspace_id)) : [],
    // orderVersion: the coordinator's order changed
    [reorder, orderVersion, machineId, snapshot]);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  // a finger's drag (lib/touchReorder.ts): the row it holds and the row it is over
  const [touchDrag, setTouchDrag] = useState<{ source: string; over: string | null } | null>(null);
  // the browser's drag and drop is a mouse's: on a touch screen a long press lifts the row instead
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  // a row's ⋯ opens a sheet at a phone's width and a popover above it (RowMenu): the button says which (G-037)
  const sheet = useMediaQuery(SHEET_QUERY);
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const rosterId = useId();
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const revealOpenedWorkspace = useRef<string | null>(null);
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => storedWorktreeCollapsed(machineId, snapshot?.workspaces.flatMap((workspace) => workspace.worktree ? [workspace.worktree.repo_key] : []) ?? []));
  // the pane each workspace was last seen on in this browser: its row keeps showing and opening
  // that one, also after the page reloads (lib/lastViewedPane.ts). Kept once per pane opened, not
  // per snapshot, and a workspace opened again on the same pane becomes the newest seen again.
  const viewedWorkspaceId = selectedPaneId ? snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id : undefined;
  useEffect(() => {
    if (selectedPaneId && viewedWorkspaceId) rememberViewedPane("workspace", machineId, viewedWorkspaceId, selectedPaneId);
  }, [machineId, selectedPaneId, viewedWorkspaceId]);

  /** the fold of a repository's worktrees as drawn: the saved one, or under a filter the one it holds */
  const worktreesFolded = (repoKey: string, children: readonly Pick<WorkspaceInfo, "workspace_id">[]): boolean => {
    if (filtered === null) return collapsedWorktrees.has(repoKey);
    return filterFolds.get(repoKey) ?? (collapsedWorktrees.has(repoKey) && !children.some((child) => filtered.revealedWorkspaces.has(child.workspace_id)));
  };
  const toggleWorktrees = (repoKey: string, folded: boolean): void => {
    if (filtered === null) setWorktreeCollapsed(repoKey, !folded);
    else setFilterFolds((current) => new Map(current).set(repoKey, !folded));
  };

  const setWorktreeCollapsed = (repoKey: string, collapsed: boolean): void => {
    setCollapsedWorktrees((current) => {
      if (current.has(repoKey) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(repoKey); else next.delete(repoKey);
      return next;
    });
    try {
      if (collapsed) localStorage.setItem(worktreeCollapsedKey(machineId, repoKey), "1");
      else localStorage.removeItem(worktreeCollapsedKey(machineId, repoKey));
    } catch {}
  };

  useEffect(() => {
    if (inlineError === null) return;
    const timer = window.setTimeout(() => setInlineError(null), ERROR_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [inlineError]);

  useEffect(() => {
    if (!snapshot) return;
    // New worktree groups bring their stored fold state after reconnecting or creating a workspace.
    setCollapsedWorktrees((current) => {
      const keys = snapshot.workspaces.flatMap((workspace) => workspace.worktree && !current.has(workspace.worktree.repo_key) ? [workspace.worktree.repo_key] : []);
      const stored = storedWorktreeCollapsed(machineId, keys);
      return stored.size === 0 ? current : new Set([...current, ...stored]);
    });
  }, [snapshot, machineId]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const roster = useMemo(() => rosterPanes(snapshot?.panes ?? [], selectedPaneId), [snapshot?.panes, selectedPaneId]);
  const agentRows = useMemo(() => sidebarAgents(snapshot), [snapshot]);
  const agentByPane = useMemo(() => new Map(agentRows.map((entry) => [entry.pane.pane_id, entry])), [agentRows]);
  const agentNames = useMemo(() => workspaceAgentLabels(agentRows), [agentRows]);
  // a repository's worktree workspaces hang under one on its main checkout (lib/workspaceOrder.ts)
  const worktreeGroups = useMemo(() => groupWorktrees(orderedWorkspaces), [orderedWorkspaces]);
  // pinned workspaces stand first, in a card, in pin order (shared with the other browsers,
  // lib/preferencesSync.ts); their moves change pins, while the rest change herdr's order
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const pinnedIds = useMemo(() => pinnedWorkspaceIds(pins, machineId), [pins, machineId]);
  const shownGroups = useMemo(() => splitPinnedGroups(worktreeGroups, pinnedIds, (workspace) => workspace.workspace_id), [worktreeGroups, pinnedIds]);
  // under a filter only the kept rows are drawn, in the same order, in the same groups and cards; pins, folds
  // and herdr's order are read from the whole roster as before, and a move waits until the filter is cleared
  const visibleGroups = useMemo(() => filtered === null ? shownGroups : { pinned: filterWorkspaceGroups(shownGroups.pinned, filtered.workspaces), rest: filterWorkspaceGroups(shownGroups.rest, filtered.workspaces) }, [shownGroups, filtered]);
  // a folded background part still shows the workspace that is open and one whose agent asks a question
  const inSight = (group: WorkspaceGroup<WorkspaceInfo>): boolean => [group.workspace, ...group.children].some((member) => member.workspace_id === viewedWorkspaceId
    || (online && rollupStatus(roster.filter((pane) => pane.workspace_id === member.workspace_id).map((pane) => activity.status(machineId, pane))) === "blocked"));
  const drawnGroup = (group: WorkspaceGroup<WorkspaceInfo>): boolean => roster.some((pane) => pane.workspace_id === group.workspace.workspace_id);
  // a repository's worktrees file with it, also once a pin of the repository sets them apart as rows of their own
  const worktreeIds = new Set(worktreeGroups.flatMap((group) => group.children.map((child) => child.workspace_id)));
  type Parts = { people: WorkspaceGroup<WorkspaceInfo>[]; background: WorkspaceGroup<WorkspaceInfo>[]; shown: WorkspaceGroup<WorkspaceInfo>[] };
  const parts = (groups: WorkspaceGroup<WorkspaceInfo>[]): Parts => {
    if (!backgroundApart) return { people: groups, background: [], shown: [] };
    const { people, background } = splitBackgroundGroups(groups, worktreeIds);
    const drawn = background.filter(drawnGroup);
    return { people, background: drawn, shown: backgroundFolded ? drawn.filter(inSight) : drawn };
  };
  const visibleParts = parts(visibleGroups.rest);
  const movableParts = parts(shownGroups.rest);
  // the rows as drawn, filter and folds included, for the previous/next workspace steps (lib/adjacentTarget.ts)
  const drawnRows = workspaceRows([...visibleGroups.pinned, ...visibleParts.people, ...visibleParts.shown], (group) => worktreesFolded(group.workspace.worktree?.repo_key ?? "", group.children), viewedWorkspaceId ?? null).join("\n");
  useEffect(() => publishWorkspaceRows(machineId, drawnRows === "" ? [] : drawnRows.split("\n")), [machineId, drawnRows]);
  // a pinned head's worktrees remain outside the card, but cannot move away from their repository
  const fixedIds = useMemo(() => new Set([...pinnedGroupIds(worktreeGroups, pinnedIds, (workspace) => workspace.workspace_id)].filter((id) => !pinnedIds.includes(id))), [worktreeGroups, pinnedIds]);
  // a row moves among the rows of its own part; a folded part's rows stay put, as under a filter, since a
  // move there would also pass the rows the fold hides
  const stillIds = new Set(backgroundFolded ? movableParts.background.flatMap((group) => [group.workspace, ...group.children].map((member) => member.workspace_id)) : []);
  const movableGroups = [...movableParts.people, ...backgroundFolded ? [] : movableParts.background].filter((group) => !fixedIds.has(group.workspace.workspace_id));
  const partOf = (group: WorkspaceGroup<WorkspaceInfo>): boolean => backgroundApart && isBackgroundWorkspace(group.workspace) && !worktreeIds.has(group.workspace.workspace_id);
  // a pin moves the row to the other list, so React draws it anew: the row that had the focus gets it back
  const refocusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = refocusRow.current;
    if (id === null) return;
    refocusRow.current = null;
    workspaceRoot.current?.querySelector<HTMLElement>(`.workspace-group[data-workspace="${CSS.escape(id)}"] > .workspace-header .workspace-select`)?.focus({ preventScroll: true });
  }, [pins]);
  const togglePin = (state: MenuState): void => {
    const id = state.workspace.workspace_id;
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    if (back?.closest(`.workspace-group[data-workspace="${CSS.escape(id)}"]`)) refocusRow.current = id;
    // pins of workspaces gone from this PC leave with a change of the user's, never by themselves
    const live = new Set(snapshot?.workspaces.map((workspace) => workspace.workspace_id) ?? []);
    setSidebarPins(toggleSidebarPin(pruneWorkspacePins(pins, machineId, live), workspacePinKey(machineId, id)));
  };

  useLayoutEffect(() => {
    const id = revealOpenedWorkspace.current;
    if (!id) return;
    const row = [...(workspaceRoot.current?.querySelectorAll<HTMLElement>(".workspace-group") ?? [])].find((candidate) => candidate.dataset.workspace === id);
    const scroller = workspaceRoot.current?.closest<HTMLElement>(".machine-list");
    if (!row || !scroller || scroller.clientHeight === 0) return;
    const item = row.getBoundingClientRect();
    const panel = scroller.getBoundingClientRect();
    if (item.top < panel.top || item.bottom > panel.bottom) {
      scroller.scrollTop += (item.top + item.bottom - panel.top - panel.bottom) / 2;
    }
    revealOpenedWorkspace.current = null;
  }, [snapshot, selectedPaneId, branches]);

  const noteError = (message: string, workspaceId?: string, detail: string | null = null): void => setInlineError({ message, workspaceId, detail });

  /** the pane a workspace's row shows and opens, among the panes the row stands for */
  const currentPane = (workspace: WorkspaceInfo, panes: PaneInfo[]): PaneInfo => {
    const pick = (id: string | null | undefined) => (id ? panes.find((pane) => pane.pane_id === id) : undefined);
    return pick(selectedPaneId)
      ?? pick(lastViewedPane("workspace", machineId, workspace.workspace_id))
      ?? pick(snapshot?.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes.find((pane) => pane.focused)
      ?? panes[0]!;
  };

  /**
   * What leads a row: the coding agent in the pane the row opens, so the mark never promises an
   * agent a click would not reach. A shell is a terminal, a linked worktree without an agent its branch.
   */
  const rowMark = (pane: PaneInfo, linked: boolean) => {
    const mark = paneMark(agentByPane.get(pane.pane_id));
    return (
      <span className="sidebar-mark" aria-hidden="true">
        {mark !== null ? <AgentMark agent={mark} size={18} /> : linked ? <GitBranch /> : <Terminal />}
      </span>
    );
  };
  /** the mark in words, for a reader who cannot see it */
  const markName = (pane: PaneInfo): string => {
    const entry = agentByPane.get(pane.pane_id);
    return entry?.agentLabel ?? entry?.canonicalAgent ?? t("Shell");
  };
  const agentsTitle = (workspace: WorkspaceInfo): string | null => {
    const names = agentNames.get(workspace.workspace_id);
    return names ? t("Agents: {names}", { names: names.join(", ") }) : null;
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  // A close takes the workspace with it, so it asks first, as herdr's ui.confirm_close does.
  // The row is gone afterwards, so focus moves to the header's workspace-list toggle.
  const leave = async (close: () => Promise<void>): Promise<void> => {
    await close();
    setConfirm(null);
    focusWorkspaceListToggle();
  };

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a pane closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const panes = snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? [];
    const paneCount = Math.max(1, panes.length);
    // a worktree workspace: its checkout can be deleted; the repository's workspace: herdr closes
    // every workspace of the repository with it (any other one on the main checkout too, whatever
    // group it shows under here), and refuses without close_group
    const linked = workspace.worktree?.is_linked_worktree === true;
    const repoKey = workspace.worktree?.repo_key;
    const sameRepo = linked || repoKey === undefined ? [] : (snapshot?.workspaces.filter((candidate) => candidate.workspace_id !== workspace.workspace_id && candidate.worktree?.repo_key === repoKey) ?? []);
    const worktrees = sameRepo.filter((candidate) => candidate.worktree?.is_linked_worktree);
    const otherHeads = sameRepo.length > worktrees.length;
    // making or opening a worktree is a drive feature, and the dialog's checkout list is refused to a watching device
    const worktreeItems: RowMenuItem[] = (workspace.worktree || repositoryWorkspaces.has(workspace.workspace_id)) && !linked && !watching && worktreesOffered ? [
      { id: "new-worktree", label: t("New worktree"), icon: GitBranch, run: () => setWorktreeDialog({ mode: "create", workspace }) },
      { id: "open-worktree", label: t("Open worktree…"), icon: FolderOpen, run: () => setWorktreeDialog({ mode: "open", workspace }) },
    ] : [];
    const closes = [workspace.workspace_id, ...sameRepo.map((candidate) => candidate.workspace_id)];
    const scope = (group: boolean): CloseScope | undefined => closeScope(snapshot, workspace.workspace_id, group) ?? undefined;
    const deleteItems: RowMenuItem[] = linked && worktreesOffered && !holdsLock([workspace.workspace_id]) ? [{
      id: "delete-worktree", label: t("Delete worktree checkout…"), icon: Trash2, danger: true,
      run: () => setConfirm({
        closes: scope(false),
        title: t("Delete the checkout of {name}?", { name: workspace.label }),
        body: t("The folder at {path} is deleted and the workspace closes. The branch stays.", { path: workspace.worktree?.checkout_path ?? "" }),
        action: t("Delete"),
        run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id }); }),
        // git refuses a checkout with unsaved changes: the refusal shows, and the action becomes a forced one
        escalation: { label: t("Delete anyway"), code: "dirty_worktree_requires_force", run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id, force: true }); }) },
      }),
    }] : [];
    // a repository's other open workspaces go with it
    const closeItem: RowMenuItem = { id: "close", label: t("Close workspace"), icon: X, danger: true, divider: true, run: () => setConfirm({
      closes: scope(sameRepo.length > 0),
      title: t("Close workspace {name}?", { name: workspace.label }),
      body: (worktrees.length > 0
        ? t(paneCount === 1
          ? (worktrees.length === 1 ? "{n} pane and {m} worktree workspace close with it; the agents in them stop, and the checkout stays." : "{n} pane and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay.")
          : (worktrees.length === 1 ? "{n} panes and {m} worktree workspace close with it; the agents in them stop, and the checkout stays." : "{n} panes and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay."), { n: paneCount, m: worktrees.length })
        : t(paneCount === 1 ? "{n} pane closes with it, and the agent in it stops." : "{n} panes close with it, and the agents in them stop.", { n: paneCount }))
        + (otherHeads ? ` ${t("The other workspaces open on this repository's main checkout close too.")}` : ""),
      run: () => leave(() => closeWorkspace(workspace.workspace_id, sameRepo.length > 0)),
    }) };
    // One native workspace menu for both the pointer and the explicit ⋯ button.
    const folded = repoKey !== undefined && worktreesFolded(repoKey, worktrees);
    const pinned = pinnedIds.includes(workspace.workspace_id);
    return [
      pinned
        ? { id: "unpin-workspace", label: t("Unpin workspace"), icon: PinOff, run: () => togglePin(state) }
        : { id: "pin-workspace", label: t("Pin workspace"), icon: Pin, run: () => togglePin(state) },
      ...(!renameOffered || !renamesWorkspace(workspace.workspace_id) ? [] : [{ id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => beginWorkspaceRename(workspace) }]),
      // the folder's earlier sessions, listed for the agent of the pane the row opens
      ...(historyOffered && !watching ? [{ id: "session-history", label: t("Earlier sessions…"), icon: History, run: () => actions.openSessionHistory({ machineId, workspaceId: workspace.workspace_id, agent: (panes.length > 0 ? currentPane(workspace, panes) : null)?.agent ?? null }) }] : []),
      ...(holdsLock(closes) ? [] : [{ ...closeItem, label: t(sameRepo.length > 0 ? "Close group" : "Close workspace"), divider: false }]),
      ...worktreeItems, ...deleteItems,
      ...(worktrees.length > 0 && repoKey ? [{ id: "fold", label: t(folded ? "Expand" : "Collapse"), icon: folded ? ChevronRight : ChevronDown, run: () => toggleWorktrees(repoKey, folded) }] : []),
    ];
  };

  // the roster moves under an open menu: a row that left takes its menu with it, and focus
  // goes where a closed row's focus goes
  useEffect(() => {
    if (!menu) return;
    const alive = snapshot?.workspaces.some((workspace) => workspace.workspace_id === menu.workspace.workspace_id);
    if (alive && menu.anchor.isConnected) return;
    setMenu(null);
    focusWorkspaceListToggle();
  });
  // a rename's failure is answered after later renders: it asks the roster as it is then, and
  // reopens nothing over an editor the user opened since
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const editingRef = useRef({ workspace: editingWorkspaceId });
  editingRef.current = { workspace: editingWorkspaceId };
  const editorOpen = (): boolean => editingRef.current.workspace !== null;

  const beginWorkspaceRename = (workspace: WorkspaceInfo): void => {
    setEditingWorkspaceId(workspace.workspace_id);
    setWorkspaceLabel(workspace.label);
  };

  const saveWorkspaceRename = (workspaceId: string): void => {
    const typed = workspaceLabel;
    const label = typed.trim();
    // herdr would keep an empty name, and the row would show none: the editor stays open
    if (label === "") { noteError(t("A workspace needs a name."), workspaceId); return; }
    setEditingWorkspaceId(null);
    // a name herdr set longer than the field allows is not sent back to be refused
    if (label === snapshotRef.current?.workspaces.find((candidate) => candidate.workspace_id === workspaceId)?.label) return;
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => {
      // as for a pane: the typed name survives a failed request, for as long as the workspace does
      if (!editorOpen() && snapshotRef.current?.workspaces.some((candidate) => candidate.workspace_id === workspaceId)) {
        setEditingWorkspaceId(workspaceId);
        setWorkspaceLabel(typed);
      }
      const failure = userErrorMessage(reason);
      noteError(t("Rename failed: {reason}", { reason: failure.message }), workspaceId, failure.detail);
    });
  };

  const reorderWorkspaces = (next: string[]): void => {
    if (workspaceMoves(workspaceOrder, next).length === 0) return;
    // shown at once; only the newest reorder of this PC rolls back or reports its own failure
    reorder.reorder(machineId, workspaceOrder, next, (move) => moveWorkspace(move.workspaceId, move.insertIndex)).catch((reason: unknown) => {
      const failure = userErrorMessage(reason);
      noteError(t("Reorder failed: {reason}", { reason: failure.message }), undefined, failure.detail);
    });
  };

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string, paneId: string): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
    // dropped on the pane area instead, the row opens its pane in half of it (lib/split.ts)
    event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    // a move waits until the filter is cleared, also one dragged in from another window; the Herdr app's order is its own
    if (filtered !== null || !arrange) return;
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    dropVisible(sourceId, targetWorkspaceId);
  };

  // The roster shows groups: a repository's workspace moves past the next or previous group as
  // one, and a worktree moves among its siblings, by the neighbours the list shows (pinned rows
  // are not among them). herdr moves only the workspace it is told to, so a group's worktrees
  // (a pinned one too) are moved with it (lib/workspaceOrder.ts).
  const groupIds = (group: (typeof worktreeGroups)[number]): string[] => {
    const whole = worktreeGroups.find((candidate) => candidate.workspace.workspace_id === group.workspace.workspace_id) ?? group;
    return [whole.workspace, ...whole.children].map((workspace) => workspace.workspace_id);
  };
  const moveOrder = (workspaceId: string, direction: -1 | 1): string[] | null => {
    const side = direction === 1 ? "after" : "before";
    const groupIndex = movableGroups.findIndex((group) => group.workspace.workspace_id === workspaceId);
    if (groupIndex >= 0) {
      const target = movableGroups[groupIndex + direction];
      return target && partOf(target) === partOf(movableGroups[groupIndex]!) ? placeBlock(workspaceOrder, groupIds(movableGroups[groupIndex]!), groupIds(target), side) : null;
    }
    const parent = movableGroups.find((group) => group.children.some((child) => child.workspace_id === workspaceId));
    if (!parent) return null;
    const sibling = parent.children[parent.children.findIndex((child) => child.workspace_id === workspaceId) + direction];
    return sibling ? placeBlock(workspaceOrder, [workspaceId], [sibling.workspace_id], side) : null;
  };
  const moveVisible = (workspaceId: string, direction: -1 | 1): void => {
    const pinnedIndex = shownGroups.pinned.findIndex((group) => group.workspace.workspace_id === workspaceId);
    if (pinnedIndex >= 0) {
      const target = shownGroups.pinned[pinnedIndex + direction];
      if (target) setSidebarPins(reorderWorkspacePins(currentSidebarPins(), machineId, workspaceId, target.workspace.workspace_id));
      return;
    }
    const next = moveOrder(workspaceId, direction);
    if (next !== null) reorderWorkspaces(next);
  };

  /** A card drop belongs to the pin list; crossing the card's edge changes neither order. */
  const pinnedDropTarget = (sourceId: string, targetId: string): WorkspaceGroup<WorkspaceInfo> | undefined =>
    pinnedIds.includes(sourceId) && sourceId !== targetId
      ? shownGroups.pinned.find((group) => group.workspace.workspace_id !== sourceId && (group.workspace.workspace_id === targetId || group.children.some((child) => child.workspace_id === targetId)))
      : undefined;
  const dropVisible = (sourceId: string, targetId: string): void => {
    const target = pinnedDropTarget(sourceId, targetId);
    if (target) {
      setSidebarPins(reorderWorkspacePins(currentSidebarPins(), machineId, sourceId, target.workspace.workspace_id));
      return;
    }
    const next = dropOrder(sourceId, targetId);
    if (next !== null) reorderWorkspaces(next);
  };

  /** the order a dropped workspace makes, or none when the drop crosses a group's edge */
  const dropOrder = (sourceId: string, targetId: string): string[] | null => {
    const sourceGroup = movableGroups.find((group) => group.workspace.workspace_id === sourceId);
    if (sourceGroup) {
      const targetGroup = movableGroups.find((group) => group.workspace.workspace_id === targetId || group.children.some((child) => child.workspace_id === targetId));
      if (!targetGroup || targetGroup === sourceGroup || partOf(targetGroup) !== partOf(sourceGroup)) return null;
      const movingDown = workspaceOrder.indexOf(sourceId) < workspaceOrder.indexOf(targetGroup.workspace.workspace_id);
      return placeBlock(workspaceOrder, groupIds(sourceGroup), groupIds(targetGroup), movingDown ? "after" : "before");
    }
    const parent = movableGroups.find((group) => group.children.some((child) => child.workspace_id === sourceId));
    if (!parent || sourceId === targetId || !parent.children.some((child) => child.workspace_id === targetId)) return null;
    const movingDown = workspaceOrder.indexOf(sourceId) < workspaceOrder.indexOf(targetId);
    return placeBlock(workspaceOrder, [sourceId], [targetId], movingDown ? "after" : "before");
  };

  // a finger's drag lands where the mouse's does: the same groups, the same index for herdr
  const touchHandlers = useRef<Parameters<typeof watchTouchReorder>[1] | null>(null);
  touchHandlers.current = {
    canLift: (id) => editingWorkspaceId !== id && !fixedIds.has(id) && !stillIds.has(id) && filtered === null && arrange,
    onLift: (id) => { setMenu(null); setTouchDrag({ source: id, over: id }); },
    onOver: (id) => setTouchDrag((current) => current && { ...current, over: id }),
    onDrop: (id, target) => {
      setTouchDrag(null);
      if (target !== null && target !== id) dropVisible(id, target);
    },
    onCancel: () => setTouchDrag(null),
  };
  useEffect(() => {
    const root = workspaceRoot.current;
    if (!root) return;
    return watchTouchReorder(root, {
      canLift: (id) => touchHandlers.current?.canLift(id) ?? false,
      onLift: (id) => touchHandlers.current?.onLift(id),
      onOver: (id) => touchHandlers.current?.onOver(id),
      onDrop: (id, target) => touchHandlers.current?.onDrop(id, target),
      onCancel: () => touchHandlers.current?.onCancel(),
    });
  }, []);

  /** where a held row would land, drawn as a line: before or after a row, or after a group's worktrees */
  const dropMark = ((): { id: string; side: "before" | "after"; children: boolean } | null => {
    if (!touchDrag?.over || touchDrag.over === touchDrag.source) return null;
    const pinnedTarget = pinnedDropTarget(touchDrag.source, touchDrag.over);
    if (pinnedTarget) {
      const down = pinnedIds.indexOf(touchDrag.source) < pinnedIds.indexOf(pinnedTarget.workspace.workspace_id);
      return { id: pinnedTarget.workspace.workspace_id, side: down ? "after" : "before", children: down && pinnedTarget.children.length > 0 };
    }
    if (dropOrder(touchDrag.source, touchDrag.over) === null) return null;
    const down = workspaceOrder.indexOf(touchDrag.source) < workspaceOrder.indexOf(touchDrag.over);
    const sourceGroup = movableGroups.some((group) => group.workspace.workspace_id === touchDrag.source);
    const targetGroup = sourceGroup ? movableGroups.find((group) => group.workspace.workspace_id === touchDrag.over || group.children.some((child) => child.workspace_id === touchDrag.over)) : undefined;
    if (targetGroup) {
      const groupDown = workspaceOrder.indexOf(touchDrag.source) < workspaceOrder.indexOf(targetGroup.workspace.workspace_id);
      return { id: targetGroup.workspace.workspace_id, side: groupDown ? "after" : "before", children: groupDown && targetGroup.children.length > 0 };
    }
    return { id: touchDrag.over, side: down ? "after" : "before", children: false };
  })();

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, workspaceId: string): void => {
    if (filtered !== null || !arrange || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    moveVisible(workspaceId, event.key === "ArrowUp" ? -1 : 1);
  };

  /**
   * One agent under its workspace's row, in the tree Settings turns on: its mark, its title as the Agents
   * list names it, its tab where the workspace has several, and its state in the same trailing cell. It
   * opens its pane as the Agents row does; its pin, mute and group stay in the Agents list's menu.
   */
  const renderAgentRow = (entry: SidebarAgent) => {
    const { pane, agent } = entry;
    const selected = pane.pane_id === selectedPaneId;
    const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
    const tabName = agentTabName(entry.tab, snapshot?.tabs.filter((tab) => tab.workspace_id === pane.workspace_id) ?? [], t);
    // the live name other tools address the agent by, as the Agents row says it: two agents of one title tell apart by it
    const name = agent?.name?.trim() || null;
    const place = [...new Set([name, tabName])].filter((part): part is string => part !== null && part !== title).join(" · ") || null;
    const kind = entry.agentLabel ?? entry.canonicalAgent;
    const mark = paneMark(entry);
    // under the filter a row it did not match is there for the selection, drawn as context as in the Agents list
    const context = filtered !== null && !filtered.matchedPanes.has(pane.pane_id);
    return <li key={pane.pane_id} className={`workspace-agent${selected ? " is-selected" : ""}${context ? " is-filter-context" : ""}`} data-agent-pane={pane.pane_id}>
      <button type="button" className="workspace-agent-select" disabled={!online} aria-current={selected ? "true" : undefined}
        title={[...new Set([title, kind, name, tabName, pane.cwd].filter(Boolean))].join(" — ")}
        draggable={online && !coarsePointer}
        // dropped on the pane area, the row opens its pane in half of it (lib/split.ts)
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId: pane.pane_id }));
        }}
        onPointerDown={(event) => { if (event.button === 0 && !event.ctrlKey && !selected && pane.agent != null) pressPane?.(machineId, pane.pane_id); }}
        onClick={() => actions.selectPane(pane.pane_id)}
      >
        <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
        {kind && kind !== title && <span className="visually-hidden">{kind}: </span>}
        <span className="workspace-agent-title">{title}</span>
        {place && <span className="workspace-agent-place">{place}</span>}
        {context && selected && <span className="sidebar-filter-note">{t("Selected")}</span>}
        {/* the counts give way before the title in a narrow sidebar: cut at the row's trailing cell, never over it */}
        <span className="workspace-agent-badges">
          <BackgroundBadge count={online ? pane.background_tasks : 0} />
          <PlanBadge plan={online ? pane.plan : undefined} />
          <ContextBadge context={online && settings.sidebarContext ? pane.context : undefined} />
        </span>
        <span className="sidebar-pane-meta">{online && pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge compact status={online ? activity.status(machineId, pane) : undefined} />}</span>
      </button>
    </li>;
  };

  const renderWorkspaceRow = (workspace: WorkspaceInfo, children: WorkspaceInfo[] = [], nested = false, drop?: "before" | "after") => {
    const panes = roster.filter((pane) => pane.workspace_id === workspace.workspace_id);
    if (panes.length === 0) return null;
    const pane = currentPane(workspace, panes);
    // the tree's agents of this workspace, the Agents list's rows in its order; under the filter the ones it keeps, as that list does
    const workers = agentTree ? agentRows.filter((entry) => entry.pane.workspace_id === workspace.workspace_id && (filtered === null || filtered.panes.has(entry.pane.pane_id))) : [];
    // the selected agent's own row carries the selection's fill, its workspace's row the place
    const workerSelected = workers.some((entry) => entry.pane.pane_id === selectedPaneId);
    const selected = panes.some((candidate) => candidate.pane_id === selectedPaneId);
    const repoKey = workspace.worktree?.repo_key;
    const linked = workspace.worktree?.is_linked_worktree === true;
    const branch = branches.get(workspace.workspace_id);
    const branchTitle = branch?.branch ?? (branch?.isDetached ? t("Detached HEAD") : null);
    // the row says the workspace's name, the one its owner gave it or herdr made from the branch; the
    // branch itself is the tooltip's and the menu's, where the name does not already say it
    const rowTitle = workspace.label;
    const secondaryBranch = linked && branchTitle && workspace.label !== branchTitle && workspace.label !== worktreeLabel(branchTitle) ? branchTitle : null;
    // the compact rows (the default), as herdr-app's Spaces list: one line, the name without herdr's worktree prefix and
    // hash, and a branch other than the default one dim at its end, unless it only repeats the name
    const compact = !twoLine;
    // only a worktree herdr opened has a name it made: a name the user chose is drawn whole
    const shownTitle = compact && linked ? compactWorktreeName(rowTitle) : rowTitle;
    const tailBranch = compact ? compactBranch(branchTitle) : null;
    const branchTail = tailBranch !== null && branchTitle !== null && !sameName(branchTitle, rowTitle) && tailBranch !== worktreeLabel(shownTitle) ? tailBranch : null;
    // the tooltip and the menu keep the exact branch (its slashes) even where the row does not repeat it
    const branchNote = branchTitle && branchTitle !== workspace.label ? branchTitle : null;
    const paths = [...new Set([workspace.worktree?.checkout_path, pane.cwd].filter((path): path is string => Boolean(path)))];
    // a row the filter keeps for the selection or as a match's head, not as a match, is drawn as context,
    // and the selected one says so in words; a fold with a match in it stands open while the filter lasts
    const context = filtered !== null && !filtered.matchedWorkspaces.has(workspace.workspace_id);
    const collapsed = children.length > 0 && repoKey !== undefined && worktreesFolded(repoKey, children);
    // a folded group's parent stands for its worktrees too, as herdr's collapsed parent does:
    // a checkout that waits or has finished must not hide behind the fold
    const statusPanes = collapsed ? [...panes, ...children.flatMap((child) => roster.filter((candidate) => candidate.workspace_id === child.workspace_id))] : panes;
    // on two lines the row says what its pane is doing, and the workspace it has named until now sits under that
    const lines = twoLine ? taskRowLines({ paneTitle: displayPaneTitle(pane), labelled: Boolean(pane.label?.trim()), folder: cwdBasename(pane.cwd), workspace: rowTitle, alias: secondaryBranch }) : null;
    // a folded group still shows the checkout that is open; the count is of the ones put away
    const foldedCount = collapsed ? children.filter((child) => !roster.some((candidate) => candidate.workspace_id === child.workspace_id && candidate.pane_id === selectedPaneId)).length : 0;
    const editingWorkspace = editingWorkspaceId === workspace.workspace_id;
    // a row that cannot move still drags its pane into half of the pane area; on herdr-core only the move is off
    const placed = fixedIds.has(workspace.workspace_id) || stillIds.has(workspace.workspace_id) || filtered !== null;
    const fixed = placed || !arrange;
    const filterNote = context && selected ? <span className="sidebar-filter-note">{t("Selected")}</span> : null;
    const menuOpen = menu?.workspace.workspace_id === workspace.workspace_id;
    const contentsId = `${rosterId}-worktrees-${encodeURIComponent(workspace.workspace_id)}`;
    // without a project icon the folder itself says the fold's state: open while the worktrees show
    const unfolded = children.length > 0 && repoKey !== undefined && !collapsed;
    const face = <WorkspaceFavicon root={workspace.worktree?.checkout_path ?? pane.cwd ?? null} fallback={<span className="sidebar-mark workspace-folder" aria-hidden="true">{unfolded ? <FolderOpen /> : <Folder />}</span>} />;
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void => setMenu(menuOpen ? null : { anchor, point, previousFocus, workspace, title: rowTitle, place: [branchNote, ...paths].filter(Boolean).join(" · ") || workspace.label });
    return <li
      className={`workspace workspace-group pane-item${selected ? " is-selected" : ""}${workerSelected ? " has-selected-agent" : ""}${collapsed ? " is-collapsed" : ""}${context ? " is-filter-context" : ""}${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}${touchDrag?.source === workspace.workspace_id ? " is-lifted" : ""}`}
      key={workspace.workspace_id}
      data-workspace={workspace.workspace_id}
      data-branch={branchTitle ?? undefined}
      data-drop={drop}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => onDrop(event, workspace.workspace_id)}
    >
      <div className="workspace-header"
        onMouseDownCapture={(event) => { if ((event.button === 2 || (event.button === 0 && event.ctrlKey)) && !(event.target as HTMLElement).closest("input")) event.preventDefault(); }}
        onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
        {/* a workspace leads with its own face, the project's icon or else a folder; when linked
            worktrees sit under it, that face is also the fold, and turns to an open or closed folder under a pointer */}
        {nested ? null : children.length > 0 && repoKey !== undefined ? <button
          type="button"
          className="sidebar-row-action workspace-toggle"
          aria-label={collapsed ? t("Expand worktrees of {name}", { name: workspace.label }) : t("Collapse worktrees of {name}", { name: workspace.label })}
          title={collapsed ? t("Expand worktrees of {name}", { name: workspace.label }) : t("Collapse worktrees of {name}", { name: workspace.label })}
          aria-expanded={!collapsed}
          aria-controls={contentsId}
          onClick={() => toggleWorktrees(repoKey, collapsed)}
        >{face}<span className="workspace-toggle-fold" aria-hidden="true">{collapsed ? <Folder /> : <FolderOpen />}</span></button> : face}
        <div
          className="pane-select workspace-select"
          role="button"
          tabIndex={0}
          draggable={!coarsePointer && !editingWorkspace && !placed}
          onDragStart={(event) => { if (!editingWorkspace) onDragStart(event, workspace.workspace_id, pane.pane_id); }}
          onDragEnd={() => setDragWorkspaceId(null)}
          aria-keyshortcuts={fixed ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
          aria-description={fixed ? undefined : `${t("Reorder workspace {name}", { name: workspace.label })} · ${t("Drag to reorder · Alt+↑/↓")}`}
          data-pane={pane.pane_id}
          aria-current={selected ? "true" : undefined}
          title={[`${pane.pane_id} — ${rowTitle}`, branchNote, ...paths, paneTitle(pane), agentsTitle(workspace)].filter(Boolean).join(" — ")}
          onPointerDown={(event) => { if (event.button === 0 && !event.ctrlKey && !selected && pane.agent != null) pressPane?.(machineId, pane.pane_id); }}
          onClick={() => actions.selectPane(pane.pane_id)}
          onKeyDown={(event) => {
            onRowKeyDown(event, workspace.workspace_id);
            if (event.defaultPrevented) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            actions.selectPane(pane.pane_id);
          }}
        >
          {/* a compact top-level row keeps its face alone; a worktree, which has none, keeps its mark */}
          {(!compact || nested) && rowMark(pane, workspace.worktree?.is_linked_worktree === true)}
          {editingWorkspace ? <input
            className="input workspace-rename-input"
            aria-label={t("Workspace name")}
            autoFocus
            maxLength={MAX_LABEL_CHARS}
            value={workspaceLabel}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setWorkspaceLabel(event.target.value)}
            onBlur={() => setEditingWorkspaceId(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id);
              if (event.key === "Escape") setEditingWorkspaceId(null);
            }}
          /> : lines ? <span className="workspace-copy is-two-line">
            <span className="workspace-line">
              <span className="workspace-name">{lines.title}</span>
              {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
              {filterNote}
            </span>
            {lines.place && <span className="workspace-place">{lines.place}</span>}
          </span> : <span className="workspace-copy">
            <span className="workspace-name">{shownTitle}</span>
            {!compact && secondaryBranch && <span className="worktree-workspace-label">{secondaryBranch}</span>}
            {branchTail && <span className="workspace-branch-tail">{branchTail}</span>}
            {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
            {filterNote}
          </span>}
          <span className="sidebar-pane-meta">
            <span className="visually-hidden">{markName(pane)}</span>
            {online && pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge compact status={online ? rollupStatus(statusPanes.map((candidate) => activity.status(machineId, candidate))) : undefined} />}
          </span>
        </div>
        <div className="workspace-actions">
          <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: rowTitle })} aria-haspopup={sheet ? "dialog" : "menu"} aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
      </div>
      {inlineError?.workspaceId === workspace.workspace_id && <p className="sidebar-inline-error" role="alert">{inlineError.message}{inlineError.detail !== null && <><br /><code>{inlineError.detail}</code></>}</p>}
      {/* the worktrees drawn under it go on from the same branch: the last agent is a tee, not an elbow */}
      {workers.length > 0 && <ul className="workspace-agents" aria-label={t("Agents in {name}", { name: rowTitle })} data-more={children.some((child) => !collapsed || roster.some((candidate) => candidate.workspace_id === child.workspace_id && candidate.pane_id === selectedPaneId)) ? "" : undefined}>{workers.map(renderAgentRow)}</ul>}
    </li>;
  };

  /** a top-level row, and a repository's worktrees indented under it */
  const renderGroup = ({ workspace, children }: WorkspaceGroup<WorkspaceInfo>) => {
    const selectedIn = (child: WorkspaceInfo): boolean => roster.some((pane) => pane.workspace_id === child.workspace_id && pane.pane_id === selectedPaneId);
    const folded = worktreesFolded(workspace.worktree?.repo_key ?? "", children);
    const shownChildren = children.filter((child) => !folded || selectedIn(child));
    const childrenHidden = shownChildren.length === 0;
    // a group moved below this one lands after its worktrees, and the line says so
    const afterChildren = dropMark?.id === workspace.workspace_id && dropMark.children;
    return <Fragment key={workspace.workspace_id}>
      {renderWorkspaceRow(workspace, children, false, dropMark?.id === workspace.workspace_id && (!dropMark.children || childrenHidden) ? dropMark.side : undefined)}
      {children.length > 0 && <li
        className="worktree-children"
        id={`${rosterId}-worktrees-${encodeURIComponent(workspace.workspace_id)}`}
        hidden={childrenHidden}
        data-drop={afterChildren && !childrenHidden ? "after" : undefined}
      ><ul className="workspace-list">
        {shownChildren.map((child) => renderWorkspaceRow(child, [], true, dropMark?.id === child.workspace_id ? dropMark.side : undefined))}
      </ul></li>}
    </Fragment>;
  };

  return (
    <div className={`machine-workspaces${twoLine ? " is-two-line" : ""}`} ref={workspaceRoot}>
      <nav className="sidebar-list" aria-label={t("Herdr workspaces")}>
        <>
          <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
          {snapshot && snapshot.workspaces.length === 0 && (
            <div className="tree-state-empty">
              <p className="tree-state" role="status">{t("No workspaces yet")}</p>
              <button type="button" className="btn" onClick={actions.openNewSession}><Plus aria-hidden="true" />{t("New workspace")}</button>
            </div>
          )}
          {visibleGroups.pinned.some(({ workspace }) => roster.some((pane) => pane.workspace_id === workspace.workspace_id)) && <>
            <p className="sidebar-pinned-label" aria-hidden="true"><span><Pin />{t("Pinned")}</span></p>
            <ul className="workspace-list workspace-list-pinned sidebar-pinned" aria-label={t("Pinned")}>{visibleGroups.pinned.map(renderGroup)}</ul>
          </>}
          <ul className="workspace-list">{visibleParts.people.map(renderGroup)}</ul>
          {visibleParts.background.length > 0 && <>
            <button type="button" className="workspace-background-toggle" aria-expanded={!backgroundFolded} aria-controls={`${rosterId}-background`} onClick={toggleBackground}>
              {backgroundFolded ? <ChevronRight className="workspace-background-caret" aria-hidden="true" /> : <ChevronDown className="workspace-background-caret" aria-hidden="true" />}
              <span>{t("Background workspaces")}</span><span className="workspace-background-count">{visibleParts.background.length}</span>
            </button>
            <ul className="workspace-list workspace-list-background" id={`${rosterId}-background`} aria-label={t("Background workspaces")}>{visibleParts.shown.map(renderGroup)}</ul>
          </>}
          {inlineError && inlineError.workspaceId === undefined && (
            <p className="sidebar-inline-error" role="alert">{inlineError.message}{inlineError.detail !== null && <><br /><code>{inlineError.detail}</code></>}</p>
          )}
        </>
      </nav>
      {/* the menu names the workspace it is for above its items (G-022): the popover covers the row */}
      {menu && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menu.title} subtitle={menu.place} items={menuItems(menu)} onClose={closeMenu}
        header={<span className="row-menu-target"><span className="row-menu-target-name" title={menu.title}>{menu.title}</span>{menu.place && <span className={`row-menu-target-place${menu.place === menu.workspace.label ? "" : " is-literal"}`} title={menu.place}>{menu.place}</span>}</span>} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={confirm.action ?? t("Close")} onConfirm={confirm.run} escalation={confirm.escalation} onClose={() => setConfirm(null)} />}
      {worktreeDialog && <WorktreeDialog mode={worktreeDialog.mode} workspace={worktreeDialog.workspace} onClose={() => setWorktreeDialog(null)} onOpenPane={(paneId) => { setWorktreeDialog(null); actions.selectPane(paneId); }} onOpened={(opened) => {
        rememberOpened(opened);
        revealOpenedWorkspace.current = opened.workspace_id;
        const repoKey = worktreeDialog.workspace.worktree?.repo_key;
        // opened under a filter, the group opens for the filter's time only: the saved fold stays as it was
        if (repoKey) toggleWorktrees(repoKey, true);
        setWorktreeDialog(null);
        if (opened.agent_started === true) actions.agentStarted(machineId, opened.pane_id);
        actions.selectPane(opened.pane_id);
      }} />}
    </div>
  );
}
