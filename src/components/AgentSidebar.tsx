import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bell, BellOff, ChevronDown, ChevronRight, Ellipsis, FolderInput, FolderOutput, Lock, LockOpen, Pin, PinOff, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { paneTokenValues } from "../../shared/pane-tokens.ts";
import type { AgentStatus, HerdrPane, PaneContext, PlanSummary, TabInfo } from "../../shared/protocol.ts";
import { currentAgentRowTokens, subscribeAgentRowTokens } from "../lib/agentRowTokens.ts";
import { useT } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { useEdgeFades } from "../lib/useEdgeFades.ts";
import { agentGroup, agentRoster, groupAgentRows, splitBackgroundRows, type AgentGroup, type AgentRow } from "../lib/agentRoster.ts";
import { assignAgentGroup, liveGroupKeys, loadFoldedAgentGroups, rowAgentGroup, saveFoldedAgentGroups, splitNamedGroups } from "../lib/namedAgentGroups.ts";
import { currentPaneMutes, paneMuteKey, prunePaneMutes, setPaneMutes, subscribePaneMutes, togglePaneMute } from "../lib/paneMutes.ts";
import { lockedPinKeys, locksAfterPinToggle, toggleAgentLock } from "../lib/paneLocks.ts";
import { agentContext, agentTabName, paneMark, titleOnlyNamesAgent } from "../lib/sidebarAgents.ts";
import { agentName } from "../lib/runtimeMove.ts";
import { customTabLabel } from "../lib/tabName.ts";
import { useSettings } from "../lib/settings.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { machineFilter } from "../lib/sidebarFilter.ts";
import { useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { useHiddenMachines } from "../lib/hiddenMachines.ts";
import { currentSidebarPins, pruneSidebarPins, setSidebarPins, sidebarPinKey, subscribeSidebarPins, toggleSidebarPin } from "../lib/sidebarPins.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { AgentMark, hasAgentMark } from "./AgentMark.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { BackgroundBadge, compactWorktreeName, ContextBadge, displayPaneTitle, onRowContextMenu, PlanBadge, StatusBadge } from "./Sidebar.tsx";
import "./AgentSidebar.css";

interface AgentRowBodyProps {
  /** the agent's kind or name; null draws a terminal, for a shell */
  mark: string | null;
  /** the kind the mark draws, left off the second line: said for a screen reader, since the mark is aria-hidden */
  markKind: string | null;
  title: string;
  /** the live name other tools address the agent by, when it has one */
  name: string | null;
  context: string;
  /** what herdr plugins report on the pane (`$name` tokens), in the order herdr's rows draw them */
  tokens: readonly string[];
  backgroundTasks?: number;
  plan?: PlanSummary;
  /** what its last request filled of its context, drawn only while Settings shows it on agent rows */
  paneContext?: PaneContext | undefined;
  status?: AgentStatus;
  /** why a row the filter did not match is drawn all the same: it is the selected one */
  note?: string | null;
  /** its alerts are off for everyone (lib/paneMutes.ts): said beside the state, as a word for a screen reader */
  muted: boolean;
  /** a pinned row this app does not close (lib/paneLocks.ts), said the same way */
  locked?: boolean;
  /** why a blocked agent waits, in the agent's own report (herdr-core's OSC 7501 kind and message) */
  blockedNote?: string | null;
  /** the same reason in a few words, for the row's line (blockedLabel) */
  blockedLabel?: string | null;
  /** how far the agent says it is, 0 to 100 (herdr-core's OSC 7501 progress) */
  progress?: number;
  /** a helper under the agent that started it: one line, its place and plugin values left to the tooltip */
  helper?: boolean;
  /** how long a waiting row has waited (Settings → Sidebar rows → One line), dim before its state */
  since?: string | null;
}

/** How long a row has been in its state, as herdr-app's agent rows say it: under a minute, minutes, hours, days. */
export function stateAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * A blocked agent's own reason, when it gave one: what it waits for (OSC 7501 `kind`) in words, a
 * kind not in the protocol as the agent wrote it, then its message as written.
 */
export function blockedNote(pane: Pick<HerdrPane, "agent_kind" | "agent_message">, t: (key: string) => string): string | null {
  const kind = pane.agent_kind === "permission" ? t("Needs permission")
    : pane.agent_kind === "question" ? t("Has a question")
    : pane.agent_kind === "auth" ? t("Needs sign-in")
    : pane.agent_kind || null;
  const message = pane.agent_message?.trim() || null;
  return kind && message ? `${kind}: ${message}` : kind ?? message;
}

/** A blocked agent's reason in a few words, for its row's one line: what it waits for, else its message. */
export function blockedLabel(pane: Pick<HerdrPane, "agent_kind" | "agent_message">, t: (key: string) => string): string | null {
  if (pane.agent_kind) return blockedNote({ agent_kind: pane.agent_kind }, t);
  return pane.agent_message?.trim() || null;
}

/**
 * One agent in a list: the coding agent's mark, what it is working on, who and where it is, what
 * its plugins report, and how it is doing.
 */
function AgentRowBody({ mark, markKind, title, name, context, tokens, backgroundTasks, plan, paneContext, status, note = null, muted, locked = false, blockedNote: blocked = null, blockedLabel: blockedShort = null, progress, helper = false, since = null }: AgentRowBodyProps) {
  const t = useT();
  const showProgress = progress !== undefined && (status === "working" || status === "blocked");
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      {markKind && <span className="visually-hidden">{markKind}: </span>}
      <span className="agent-main">
        <span className="agent-title-line">
          <span className="agent-title">{title}</span>
          {/* the agent's own words, as text, cut to fit: what it waits for while it is blocked (the tooltip says it all) */}
          {status === "blocked" && blockedShort && <span className="agent-blocked" aria-hidden={blocked !== null && blocked !== blockedShort ? "true" : undefined}>{blockedShort}</span>}
          {status === "blocked" && blocked !== null && blocked !== blockedShort && <span className="visually-hidden">{blocked}</span>}
          {/* how far the agent says it is, while it works or waits: its percent after the title, and in words for a
              screen reader (a role inside the row's button would not be read) */}
          {showProgress && <>
            <span className="agent-progress" aria-hidden="true">{progress}%</span>
            <span className="visually-hidden">{t("Progress {percent}%", { percent: progress })}</span>
          </>}
        </span>
        {!helper && (name || context) && <span className="agent-context">
          {name && <span className="agent-name">{name}</span>}
          {name && context && " · "}
          {context}
        </span>}
      </span>
      {/* text as the plugin wrote it, never markup; its own line in either row height, cut where it is too long */}
      {!helper && tokens.length > 0 && <span className="agent-tokens">{tokens.join(" · ")}</span>}
    </span>
    <span className="agent-row-status">
      {note !== null && <span className="sidebar-filter-note">{note}</span>}<BackgroundBadge count={backgroundTasks} /><PlanBadge plan={plan} /><ContextBadge context={paneContext} />
      {locked && <span className="agent-muted" title={t("Locked")} data-testid="agent-locked"><Lock aria-hidden="true" /><span className="visually-hidden">{t("Locked")}</span></span>}
      {muted && <span className="agent-muted" title={t("Alerts muted")} data-testid="alerts-muted"><BellOff aria-hidden="true" /><span className="visually-hidden">{t("Alerts muted")}</span></span>}
    </span>
    {since !== null && <span className="agent-since">{since}</span>}
    {/* drawn at the row's right edge, after its ⋯, as a workspace row's state is (AgentSidebar.css) */}
    <span className="agent-row-state"><StatusBadge status={status} compact detail={status === "blocked" ? blocked : null} /></span>
  </>;
}

export interface AgentSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  /** a PC's state in words, for the tooltip of a row whose PC is not connected */
  stateWord(machine: Machine): string;
  /** this device only watches: it sees the shared mutes and cannot change them */
  watching?: boolean;
  /** a fold the line above the list asks for (SidebarSplit.tsx), each new `seq` once: the caret's own fold */
  foldRequest?: { folded: boolean; seq: number } | null;
  /** the list's id, for the line that sizes it (SidebarSplit.tsx `controls`); one of its own without it */
  listId?: string;
  onSelect(machineId: string, paneId: string): void;
}

/** what a row calls itself: the pane's label, else its agent's title, else the pane's own */
function rowTitle({ pane, agent }: AgentRow["entry"]): string {
  return pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
}

/** what a row's mark already says: the agent's kind and its product name ("claude", "Claude Code"); nothing for a row with no agent mark */
function markNames(entry: AgentRow["entry"]): string[] {
  const mark = paneMark(entry);
  return mark && hasAgentMark(mark) && entry.canonicalAgent ? [entry.canonicalAgent, agentName(entry.canonicalAgent)] : [];
}

/** the tabs of a row's workspace, in herdr's order: a tab is judged by its place among them (lib/tabName.ts) */
function workspaceTabs({ machine, entry }: AgentRow): TabInfo[] {
  return machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === entry.workspace.workspace_id) ?? [];
}

/**
 * The title a row draws, which is also the one its sort by name, its helpers' line and its menu say.
 * `own` is what the row calls itself. The mark says which agent it is, so an agent's or a pane's own title that says
 * only that ("Claude Code") gives way to the workspace the agent runs in (a worktree herdr named, in its compact
 * form): rows of agents with nothing of their own to say are then told apart. `replaced` says so, and `title` is the
 * outcome. A label the user gave the pane is theirs and always stands, and a row with no agent mark keeps its title.
 * A one-line row leads with what the agent is on (the pane's label, else a tab the user named, else that title): that
 * is `drawn` there, and `title` in a two-line row.
 */
export function agentRowTitle(row: AgentRow, oneLine: boolean): { own: string; title: string; replaced: boolean; drawn: string } {
  const { pane, workspace, tab } = row.entry;
  const own = rowTitle(row.entry);
  const label = pane.label?.trim() || null;
  const worktree = workspace.worktree?.is_linked_worktree === true;
  const replaced = label === null && titleOnlyNamesAgent(own, markNames(row.entry));
  const title = replaced ? worktree ? compactWorktreeName(workspace.label) : workspace.label : own;
  if (!oneLine) return { own, title, replaced, drawn: title };
  // a tab herdr only numbers ("Tab 2") never stands in for what the agent is on: only one the user named does
  const place = workspaceTabs(row).findIndex((candidate) => candidate.tab_id === tab?.tab_id) + 1 || tab?.number;
  const named = label || (tab ? customTabLabel(tab, place) : null) || title;
  // a row titled by its worktree's own name, as herdr made it, says that name as the workspace row does
  return { own, title, replaced, drawn: worktree && named === workspace.label ? compactWorktreeName(named) : named };
}

/** Settings → Group agents by state: each group's heading */
function groupLabel(group: AgentGroup, t: (key: string) => string): string {
  switch (group) {
    case "blocked": return t("Needs you");
    case "working": return t("Working");
    case "done": return t("Done");
    case "idle": return t("Idle");
  }
}

/** the width under which the sidebar is a drawer (src/styles.css) */
const DRAWER_QUERY = "(max-width: 768px)";
/** the reader's fold of the list, kept on this device as a PC's fold is (MachineSidebar.tsx): a phone and a desktop each keep their own */
const FOLD_KEY = "ovis:agents-collapsed";

/** the one-line list's resting agents (idle, finished), folded under one line on this device; it starts folded */
const RESTING_OPEN_KEY = "ovis:agents-resting-open";

/** the fold of the background agents' part, kept the same way; it starts folded on every screen */
const BACKGROUND_FOLD_KEY = "ovis:agents-background-collapsed";

/** Settings → Fold helpers under their agent: the agents whose helpers this device lists in full, each by its pin key; every other agent's start folded */
const HELPERS_OPEN_KEY = "ovis:agents-helpers-open";

/**
 * The fold that hides a row: the nearest folded line above it in sight (an agent's helpers, a named group, the
 * background part, the one-line list's resting fold). A line that is open hides nothing under it: a resting
 * helper folded under its agent's line sits after the open resting line, and it is the helpers line that hides it.
 */
function foldControlAbove(item: Element): HTMLButtonElement | null {
  for (let above = item.previousElementSibling; above; above = above.previousElementSibling) {
    if (above.hasAttribute("hidden")) continue;
    if (!above.matches(".agent-helpers, .agent-named-group-label, .agent-background-label")) continue;
    const button = above.querySelector("button");
    if (button?.getAttribute("aria-expanded") !== "true") return button;
  }
  return null;
}

function loadOpenHelpers(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(HELPERS_OPEN_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function initialBackgroundFold(): boolean {
  try {
    return window.localStorage.getItem(BACKGROUND_FOLD_KEY) !== "0";
  } catch {
    return true;
  }
}

/** the fold the reader left on this device, or with none kept the screen's: folded in the drawer, open on a desktop */
function initialFold(): boolean {
  try {
    const stored = window.localStorage.getItem(FOLD_KEY);
    if (stored === "1" || stored === "0") return stored === "1";
  } catch { /* no storage: the screen's default */ }
  return window.matchMedia?.(DRAWER_QUERY).matches === true;
}
/**
 * The row whose menu is open, by its pin key: at its ⋯, or at the pointer for a right-click. What
 * the menu says of the row is read from the row at each render, so a value that changes while it is
 * open changes in it too.
 */
interface PinMenu { key: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null }

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces, until the reader
 * folds or opens it: that choice is kept on this device.
 * The pinned agents stand first, in a card; on a desktop only a
 * right-click (or the context-menu key) opens the menu. A row's ⋯, or a right-click on it, opens its
 * menu, which pins or unpins it, and mutes or unmutes its alerts for every browser and device.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, watching = false, foldRequest = null, listId: givenListId, onSelect }: AgentSidebarProps) {
  const t = useT();
  // a waiting row says how long it has waited, only when this page saw the wait begin: herdr reports no time of change,
  // so a row already waiting when the page opened (a reload, another device) says nothing rather than a wrong "<1m"
  const [waitStarts, setWaitStarts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const lastStatus = useRef<Map<string, AgentStatus | undefined> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ticking, setTicking] = useState(false);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const ownListId = useId();
  const listId = givenListId ?? ownListId;
  const [collapsed, setCollapsed] = useState(initialFold);
  const [backgroundCollapsed, setBackgroundCollapsed] = useState(initialBackgroundFold);
  const { settings, update: updateSettings } = useSettings();
  const pressPane = useContext(PanePressContext);
  // shared with the other browsers of this server (lib/preferencesSync.ts)
  const pinned = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  // the panes whose alerts are off, shared the same way; null on a server that keeps no such list, which then offers no mute
  const muted = useSyncExternalStore(subscribePaneMutes, currentPaneMutes, currentPaneMutes);
  // the pinned rows this app does not close, shared as a setting (lib/paneLocks.ts)
  const locked = useMemo(() => lockedPinKeys(settings.lockedAgents, pinned, settings.agentLocks), [settings.lockedAgents, pinned, settings.agentLocks]);
  // which `$name` tokens herdr's own sidebar draws, from this server's herdr config (server/herdr-sidebar.ts)
  const rowTokens = useSyncExternalStore(subscribeAgentRowTokens, currentAgentRowTokens, currentAgentRowTokens);
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes);
  // the pinned rows stand first, in the order they were pinned (lib/agentRoster.ts)
  // grouped by state, the groups order their own rows: their ties keep herdr's order, never Activity's
  const byActivity = settings.agentOrder === "activity" && !settings.agentGroups;
  const roster = useMemo(() => agentRoster(machines, { byActivity, seqs: activity.seqs, pinned }), [machines, byActivity, activity, pinned]);
  const allRows = useMemo(() => [...roster.pinned, ...roster.rest], [roster]);
  // the sidebar's filter (lib/sidebarFilter.ts) keeps the matched rows and the selected one, in the same
  // order and cards; the pins and their pruning go on reading every row
  const { filter } = useSidebarFilter();
  const split = useMemo(() => {
    if (!filter.active) return roster;
    const kept = ({ machine, entry }: AgentRow): boolean => machineFilter(filter, machine.id)?.panes.has(entry.pane.pane_id) === true;
    return { pinned: roster.pinned.filter(kept), rest: roster.rest.filter(kept) };
  }, [roster, filter]);
  const rows = useMemo(() => [...split.pinned, ...split.rest], [split]);
  // background agents (a pane tagged role=background, and its helpers) stand apart, after the rest (lib/agentRoster.ts)
  const parts = useMemo(() => splitBackgroundRows(split.rest, ({ machine, entry }) => machine.state === "connected" ? activity.status(machine.id, entry.pane) : undefined, allRows), [split, activity, allRows]);
  const rowStatus = useCallback(({ machine, entry }: AgentRow) => machine.state === "connected" ? activity.status(machine.id, entry.pane) : undefined, [activity]);
  // Settings → Group agents by state (this device): the unpinned rows in groups, needs-you first (lib/agentRoster.ts)
  const byState = useCallback((list: readonly AgentRow[]) => groupAgentRows(list, {
    sort: settings.agentGroupSort,
    status: rowStatus,
    // by the title the row draws, not the one it gave way to
    name: (row) => agentRowTitle(row, settings.sidebarRows === "one").drawn,
    seqs: activity.seqs,
  }), [settings.agentGroupSort, settings.sidebarRows, rowStatus, activity]);
  // Settings → Named agent groups (shared): the unpinned rows in the groups the user named, the ungrouped last
  // (lib/namedAgentGroups.ts); grouped by state as well, each named group lists its rows needs-you first, without headings
  const groupNames = settings.agentNamedGroups ? settings.agentGroupNames : [];
  const named = useMemo(() => groupNames.length === 0 ? null : splitNamedGroups(parts.people, settings.agentGroupOf, groupNames, allRows)
    .map(({ name, rows: groupRows }) => ({ name, rows: settings.agentGroups ? byState(groupRows).flatMap((group) => group.rows) : groupRows })),
  [groupNames, settings.agentGroupOf, settings.agentGroups, parts, allRows, byState]);
  const groups = useMemo(() => !settings.agentGroups || named !== null ? null : byState(parts.people), [settings.agentGroups, named, parts, byState]);
  // Settings → Sidebar rows → One line (the default): no headings, each waiting row with how long it has waited.
  // With Agents order → Waiting first it is herdr-app's list: the waiting rows first, the resting ones folded
  const compact = settings.sidebarRows === "one";
  const restingFold = compact && settings.agentOrder === "waiting";
  const [restingOpen, setRestingOpen] = useState(() => { try { return window.localStorage.getItem(RESTING_OPEN_KEY) === "1"; } catch { return false; } });
  const toggleResting = (): void => {
    setRestingOpen(!restingOpen);
    try { window.localStorage.setItem(RESTING_OPEN_KEY, restingOpen ? "0" : "1"); } catch { /* private mode: this page keeps it */ }
  };
  const people = useMemo(() => {
    // Settings → Agents order → Waiting first (the default); a saved Workspaces or Activity order is kept as it is
    if (settings.agentOrder !== "waiting" || groups !== null || named !== null) return parts.people;
    // an agent moves with the helpers drawn under it (lib/agentRoster.ts nestHelpers): one waits when any of them does
    const families: AgentRow[][] = [];
    for (const row of parts.people) {
      const family = families.at(-1);
      const parent = row.entry.pane.parent_pane_id;
      if (family && parent !== undefined && family.some((member) => member.machine.id === row.machine.id && member.entry.pane.pane_id === parent)) family.push(row);
      else families.push([row]);
    }
    const waits = (family: AgentRow[]) => family.some((row) => rowStatus(row) === "blocked");
    return [...families.filter(waits), ...families.filter((family) => !waits(family))].flat();
  }, [settings.agentOrder, groups, named, parts, rowStatus]);
  // read from every row, the filtered-out ones too, so a wait that ended out of sight starts again when it returns
  const statuses = allRows.map((row) => [sidebarPinKey(row.machine.id, row.entry.pane.pane_id), rowStatus(row)] as const);
  const statusSignature = statuses.map(([key, status]) => `${key}=${status ?? ""}`).join("\n");
  useEffect(() => {
    const seen = lastStatus.current;
    const at = Date.now();
    setWaitStarts((starts) => {
      const next = new Map<string, number>();
      for (const [key, status] of statuses) {
        // a PC that is away says no state: a start already seen is kept, and none is made from it on its return
        if (status === undefined) { const kept = starts.get(key); if (kept !== undefined) next.set(key, kept); continue; }
        if (status !== "blocked") continue;
        const before = seen?.get(key);
        const start = starts.get(key) ?? (before !== undefined && before !== "blocked" ? at : undefined);
        if (start !== undefined) next.set(key, start);
      }
      return next.size === starts.size && [...next].every(([key, start]) => starts.get(key) === start) ? starts : next;
    });
    setNow(at);
    lastStatus.current = new Map(statuses);
  }, [statusSignature]);
  // the wait times tick only while one is drawn
  const shouldTick = compact && waitStarts.size > 0;
  useEffect(() => { setTicking(shouldTick); }, [shouldTick]);
  const [pointerIn, setPointerIn] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [touchHeld, setTouchHeld] = useState(false);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdAfterTouch = (): void => {
    if (touchTimer.current !== null) clearTimeout(touchTimer.current);
    setTouchHeld(true);
    touchTimer.current = setTimeout(() => { touchTimer.current = null; setTouchHeld(false); }, 1000);
  };
  useEffect(() => () => { if (touchTimer.current !== null) clearTimeout(touchTimer.current); }, []);
  const waitedFor = (key: string, status: AgentStatus | undefined): string | null => {
    const since = waitStarts.get(key);
    return compact && status === "blocked" && since !== undefined ? stateAge(Math.max(0, now - since)) : null;
  };
  // the named groups this device folds; the ungrouped rows fold under ""
  const [groupFolds, setGroupFolds] = useState(loadFoldedAgentGroups);
  // a folded list (a phone's starts so) opens while the filter keeps rows in it, so a match or the selection is
  // seen, not only kept; its caret then folds and opens it for the filter's time, the list's own fold untouched
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
  // the background part opens for the filter's time the same way: a match in it is seen
  const [backgroundFilterFold, setBackgroundFilterFold] = useState<boolean | null>(null);
  // and the one-line list's resting fold: a resting agent the filter matched is seen, not only kept (a filter
  // that hid its own matches would say "no match" with the match a fold away)
  const [restingFilterOpen, setRestingFilterOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (filter.active) return;
    setFilterFold(null);
    setBackgroundFilterFold(null);
    setRestingFilterOpen(null);
  }, [filter.active]);
  const folded = filter.active ? filterFold ?? (collapsed && rows.length === 0) : collapsed;
  const backgroundFolded = filter.active ? backgroundFilterFold ?? false : backgroundCollapsed;
  const restingShown = filter.active ? restingFilterOpen ?? true : restingOpen;
  // a state change never moves a row under the pointer or the focus (HIG): while either is in the list, rows keep
  // the order and the part they were drawn in, and a row waking from the resting fold waits until it leaves. Only
  // what changes by itself waits: the reader's own doing (the filter, the resting fold, a selection, a pin) draws
  // the rows as they are at once, and that drawing is the one held from then on
  const readerKey = [filter.query, restingShown, selectedMachineId, selectedPaneId, ...pinned].join("\n");
  const held = useRef<{ readerKey: string; order: readonly string[]; active: ReadonlySet<string> } | null>(null);
  const holding = (pointerIn || focusIn || touchHeld) && held.current?.readerKey === readerKey;
  const rowKey = (row: AgentRow) => sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
  const busy = (row: AgentRow) => { const status = rowStatus(row); return status === "blocked" || status === "working" || status === "waiting"; };
  useEffect(() => {
    if (holding) return;
    held.current = { readerKey, order: people.map(rowKey), active: new Set(people.filter(busy).map(rowKey)) };
  });
  const heldOrder = holding ? held.current?.order ?? [] : [];
  const shownPeople = !holding ? people : [...people].sort((a, b) => {
    const at = (row: AgentRow) => { const index = heldOrder.indexOf(rowKey(row)); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return at(a) - at(b);
  });
  // a drag or a key on the line above folds or opens the list as its caret does: for the filter's time
  // under a filter, else kept on this device
  useEffect(() => {
    if (foldRequest === null || foldRequest.folded === folded) return;
    if (filter.active) { setFilterFold(foldRequest.folded); return; }
    setCollapsed(foldRequest.folded);
    try { window.localStorage.setItem(FOLD_KEY, foldRequest.folded ? "1" : "0"); } catch { /* private mode: this page keeps it */ }
  }, [foldRequest?.seq]);
  // the PCs this device hides are not in `machines`: their pins are kept, not taken for gone panes
  const hidden = useHiddenMachines();
  const togglePin = (key: string): void => {
    // pins of panes gone from this server leave with a change of the user's, never by themselves: the
    // list is shared, and a pane this page has not seen yet (a PC still loading) is not gone
    const live = new Set(allRows.map(({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id)));
    const next = toggleSidebarPin(pruneSidebarPins(pinned, live, machines, hidden), key);
    setSidebarPins(next);
    // a lock leaves with its pin, so a pane that later takes the same id is not locked by it; a fresh pin starts unlocked,
    // also of a lock only another tab of this browser saved (lib/settings.ts: a change made from the stored settings)
    updateSettings(({ lockedAgents }) => ({ lockedAgents: locksAfterPinToggle(lockedAgents, next, key) }));
  };
  const toggleMute = (machineId: string, paneId: string): void => {
    // as the pins: the mutes of panes a connected PC no longer has leave with this change, and no other PC's
    if (muted !== null) setPaneMutes(togglePaneMute(prunePaneMutes(muted, machines), paneMuteKey(machineId, paneId)));
  };
  // a pin moves the row to the other list, so React draws it anew: the control of the row that had
  // the focus (its row or its ⋯) gets it back
  const sectionRef = useRef<HTMLElement>(null);
  // the list fades at an edge only while rows lie past it (lib/useEdgeFades.ts)
  const listRef = useRef<HTMLDivElement>(null);
  useEdgeFades(listRef);
  const refocusPin = useRef<{ key: string; control: string } | null>(null);
  useLayoutEffect(() => {
    const target = refocusPin.current;
    if (target === null) return;
    refocusPin.current = null;
    const control = sectionRef.current?.querySelector<HTMLButtonElement>(`.agent-item[data-pin-key="${CSS.escape(target.key)}"] .${target.control}`);
    // a row unpinned into a fold (its agent's helpers, a named group, the background part) is hidden: the fold's line above it takes the focus
    const item = control?.closest("li");
    (item?.hidden ? foldControlAbove(item) : control)?.focus({ preventScroll: true });
  }, [pinned]);
  const [menu, setMenu] = useState<PinMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuRow = menu === null ? undefined : rows.find(({ machine, entry }) => machine.state !== "disconnected" && machine.state !== "error" && sidebarPinKey(machine.id, entry.pane.pane_id) === menu.key);
  // a row that left the list or whose PC stopped connecting takes its menu with it; a retry keeps it
  useEffect(() => {
    if (menu && (menuRow === undefined || !menu.anchor.isConnected)) setMenu(null);
  }, [menu, menuRow]);
  // herdr names a PC only beside another: the rows' line does the same
  // and on one line never names this PC: a row with no PC is on this one
  const machineName = (machine: Machine): string | null => machines.length > 1 && !(settings.sidebarRows === "one" && machine.kind === "local") ? machine.name : null;
  // the row's tooltip and its menu name the PC whenever there is more than one, this one included (G-019): the
  // line may leave it out, the places a reader goes for the whole do not
  const wholePlace = (machine: Machine, parts: readonly (string | null)[]): string => [...new Set([machines.length > 1 ? machine.name : null, ...parts])].filter((part): part is string => part !== null && part !== "").join(" · ");
  // a row's ⋯ opens a sheet at a phone's width and a popover above it (RowMenu): the button says which (G-037)
  const sheet = useMediaQuery(SHEET_QUERY);

  // what a row says of its agent, for the row and for its open menu
  const describe = (row: AgentRow) => {
    const { machine, entry } = row;
    const { pane, workspace, tab, agent, agentLabel } = entry;
    const online = machine.state === "connected";
    const name = agent?.name?.trim() || null;
    // the name has its own place on the line: the label beside it says the kind instead
    const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
    const tabs = workspaceTabs(row);
    const mark = paneMark(entry);
    const markAgent = mark && hasAgentMark(mark) ? mark : null;
    const { own: said, title, replaced, drawn } = agentRowTitle(row, compact);
    // the title the row gave way from, which its tooltip still says
    const ownTitle = replaced ? said : null;
    // nor does the line spend words on the agent's kind beside its mark (a screen reader still hears it, as markKind):
    // a plugin's own line for the agent says more than its kind or product name, and stays
    const parts = { agentLabel: kindLabel !== null && titleOnlyNamesAgent(kindLabel, markNames(entry)) ? null : kindLabel, title, markAgent, machineName: machineName(machine), workspaceLabel: workspace.label, tabName: agentTabName(tab, tabs, t) };
    // the workspace a title already names is not said again after it, under the whole name of a worktree either
    const contextParts = agentContext(parts).filter((part) => part !== title && !(replaced && part === workspace.label));
    const context = contextParts.join(" · ");
    const kind = kindLabel?.trim() || null;
    const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
    // a PC that is away says nothing of its agents now, its plugins' words included
    const tokens = online ? paneTokenValues(rowTokens, entry.canonicalAgent, pane.tokens ?? agent?.tokens) : [];
    // on one line a row leads with what the agent is on (its own label, else its tab's name) and says its workspace once
    if (compact) {
      const lead = drawn;
      // a named tab that leads keeps the agent's own title after it, so two agents of one tab never read the same
      const own = title !== lead && title !== workspace.label ? title : null;
      const leadParts = [...new Set([own, ...agentContext({ ...parts, title: lead, tabName: parts.tabName === lead ? null : parts.tabName, workspaceLabel: workspace.worktree?.is_linked_worktree ? compactWorktreeName(workspace.label) : workspace.label })])].filter((part): part is string => part !== null && part !== lead);
      return { online, title: lead, ownTitle, name, mark, context: leadParts.join(" · "), place: wholePlace(machine, leadParts), markKind: kind && kind !== lead && !leadParts.includes(kind) ? kind : null, tokens };
    }
    return { online, title, ownTitle, name, mark, context, place: wholePlace(machine, contextParts), markKind, tokens };
  };

  // a helper reads under the agent that started it when that row is just above it in the same list (lib/agentRoster.ts)
  const depths = (list: readonly AgentRow[]): Map<AgentRow, number> => {
    const depth = new Map<AgentRow, number>();
    const byKey = new Map<string, AgentRow>();
    for (const row of list) {
      const parent = row.entry.pane.parent_pane_id;
      const above = parent === undefined ? undefined : byKey.get(sidebarPinKey(row.machine.id, parent));
      depth.set(row, above === undefined ? 0 : (depth.get(above) ?? 0) + 1);
      byKey.set(sidebarPinKey(row.machine.id, row.entry.pane.pane_id), row);
    }
    return depth;
  };
  // the tree line of each helper: it runs on (`more`) while a later helper of the same agent follows before a
  // shallower row, and a depth-2 row has its agent's line pass through it (`through`) when that line runs on
  const treeLines = (list: readonly AgentRow[], listDepths: ReadonlyMap<AgentRow, number>): Map<AgentRow, { more: boolean; through: boolean }> => {
    const level = list.map((row) => Math.min(2, listDepths.get(row) ?? 0));
    const more = level.map((depth, index) => {
      if (depth === 0) return false;
      for (let next = index + 1; next < level.length; next++) {
        if (level[next]! < depth) return false;
        if (level[next] === depth) return true;
      }
      return false;
    });
    const lines = new Map<AgentRow, { more: boolean; through: boolean }>();
    let parentMore = false;
    list.forEach((row, index) => {
      if (level[index] === 1) parentMore = more[index]!;
      lines.set(row, { more: more[index]!, through: level[index] === 2 && parentMore });
    });
    return lines;
  };
  // Settings → Fold helpers under their agent (this device): an agent's helpers fold under one line after its row,
  // except one that needs the reader and the selected one; the filter shows what it kept, folding nothing
  const foldHelpers = settings.foldHelpers && !filter.active;
  const [openHelpers, setOpenHelpers] = useState(loadOpenHelpers);
  // the pinned card keeps the pin order, where a helper need not follow its agent: no row steps in there.
  // Each state group is a list of its own: a helper steps in only under its agent in the same group.
  const { restDepths, restLines, helpersOf, foldedHelpers } = useMemo(() => {
    const restDepths = new Map<AgentRow, number>();
    const restLines = new Map<AgentRow, { more: boolean; through: boolean }>();
    // each agent row with the helpers drawn right under it, and the helpers its fold hides
    const helpersOf = new Map<AgentRow, AgentRow[]>();
    const foldedHelpers = new Set<AgentRow>();
    for (const list of [...named ? named.map((group) => group.rows) : groups ? groups.map((group) => group.rows) : [people], parts.background]) {
      const listDepths = depths(list);
      for (const [row, depth] of listDepths) restDepths.set(row, depth);
      if (foldHelpers) {
        let agent: AgentRow | undefined;
        for (const row of list) {
          if ((listDepths.get(row) ?? 0) === 0) { agent = row; continue; }
          if (agent === undefined) continue;
          helpersOf.set(agent, [...helpersOf.get(agent) ?? [], row]);
          const open = openHelpers.includes(sidebarPinKey(agent.machine.id, agent.entry.pane.pane_id));
          const selected = row.machine.id === selectedMachineId && row.entry.pane.pane_id === selectedPaneId;
          if (!open && !selected && agentGroup(rowStatus(row)) !== "blocked") foldedHelpers.add(row);
        }
      }
      // the tree lines join the rows in sight
      const shown = list.filter((row) => !foldedHelpers.has(row));
      for (const [row, line] of treeLines(shown, listDepths)) restLines.set(row, line);
    }
    return { restDepths, restLines, helpersOf, foldedHelpers };
  }, [parts, people, groups, named, foldHelpers, openHelpers, selectedMachineId, selectedPaneId, rowStatus]);
  // a helper with the focus that folds away (it stopped needing the reader, or the selection moved) hands it to its line
  useLayoutEffect(() => {
    const active = document.activeElement;
    const item = active && sectionRef.current?.contains(active) ? active.closest("li") : null;
    if (item?.hidden) foldControlAbove(item)?.focus({ preventScroll: true });
  }, [foldedHelpers]);
  const toggleHelpers = (key: string): void => {
    // read anew, so another tab's choices are kept; as the pins, the agents gone from a loaded PC leave with this
    // change, and none of a PC still loading or hidden on this device, which cannot say its panes are gone
    const stored = loadOpenHelpers();
    const live = new Set(machines.flatMap((machine) => machine.snapshot?.panes.map((pane) => sidebarPinKey(machine.id, pane.pane_id)) ?? []));
    const kept = pruneSidebarPins(stored.filter((held) => held !== key), live, machines, hidden);
    const next = openHelpers.includes(key) ? kept : [...kept, key];
    setOpenHelpers(next);
    try { window.localStorage.setItem(HELPERS_OPEN_KEY, JSON.stringify(next)); } catch { /* private mode: this page keeps it */ }
  };
  // the line under an agent that folds its helpers: how many, and a dot for each state among them that asks for a look
  const helpersLine = (agentRow: AgentRow, helpers: readonly AgentRow[], hidden: boolean) => {
    const key = sidebarPinKey(agentRow.machine.id, agentRow.entry.pane.pane_id);
    const open = openHelpers.includes(key);
    const states = helpers.map((row) => agentGroup(rowStatus(row)));
    const blockedCount = states.filter((state) => state === "blocked").length;
    const workingCount = states.filter((state) => state === "working").length;
    // its tree line runs on to the helpers in sight under it
    const more = helpers.some((row) => !foldedHelpers.has(row));
    // whose helpers they are, by the title that agent's row draws
    const helpersOfTitle = t("Helpers of {title}", { title: describe(agentRow).title });
    return <li className="agent-helpers" key={`helpers:${key}`} data-helpers-of={key} data-more={more ? "" : undefined} hidden={hidden || undefined}>
      <button type="button" className="agent-helpers-toggle" aria-expanded={open} title={helpersOfTitle} onClick={() => toggleHelpers(key)}>
        {open ? <ChevronDown className="agent-section-caret" aria-hidden="true" /> : <ChevronRight className="agent-section-caret" aria-hidden="true" />}
        <span className="agent-helpers-name" aria-hidden="true">{t("Helpers")}</span>
        <span className="visually-hidden">{helpersOfTitle}</span>
        {blockedCount > 0 && <span className="agent-named-group-dot" data-state="blocked" title={t("{count} need you", { count: blockedCount })}><span className="visually-hidden">{t("{count} need you", { count: blockedCount })}</span></span>}
        {workingCount > 0 && <span className="agent-named-group-dot" data-state="working" title={t("{count} working", { count: workingCount })}><span className="visually-hidden">{t("{count} working", { count: workingCount })}</span></span>}
        <span className="agent-section-count">{helpers.length}</span>
      </button>
    </li>;
  };
  // a list's rows, each agent followed by its helpers line while the helpers fold; `hidden` is a fold above them all
  const listItems = (list: readonly AgentRow[], hidden = false) => list.flatMap((row) => {
    const item = agentItem(row, hidden || foldedHelpers.has(row));
    const helpers = helpersOf.get(row);
    return helpers === undefined ? [item] : [item, helpersLine(row, helpers, hidden)];
  });

  const agentItem = (row: AgentRow, hidden = false) => {
    const { machine, entry } = row;
    const { pane, agent } = entry;
    const depth = Math.min(2, restDepths.get(row) ?? 0);
    const line = restLines.get(row);
    const parentRow = depth > 0 ? allRows.find((candidate) => candidate.machine.id === machine.id && candidate.entry.pane.pane_id === pane.parent_pane_id) : undefined;
    const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
    // under the filter a row it did not match is there for the selection: drawn as context, and said so
    const filterContext = filter.active && machineFilter(filter, machine.id)?.matchedPanes.has(pane.pane_id) !== true;
    const { online, title, ownTitle, name, mark, context, place, markKind, tokens } = describe(row);
    const spoken = [title, markKind, ...(depth > 0 ? [] : [name, ...context.split(" · ")])];
    const missingContext = [entry.canonicalAgent, entry.workspace.label, machine.name].filter((part) => part && !spoken.includes(part)).join(" · ");
    // the row cuts a long value: the tooltip, and a phone's menu sheet, say each in full
    const blocked = online ? blockedNote(pane, t) : null;
    const blockedShort = online ? blockedLabel(pane, t) : null;
    const startedBy = parentRow ? t("Started by {name}", { name: describe(parentRow).title }) : null;
    const status = online ? activity.status(machine.id, pane) : undefined;
    const progress = online && pane.agent_progress !== undefined && (status === "working" || status === "blocked") ? t("Progress {percent}%", { percent: pane.agent_progress }) : null;
    const tooltip = [...new Set([pane.pane_id, title, ownTitle, agent?.title?.trim(), place, machines.length === 1 ? machine.name : null, startedBy, blocked, progress, ...tokens, markKind, name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
    const pinKey = sidebarPinKey(machine.id, pane.pane_id);
    const menuOpen = menu?.key === pinKey;
    // one menu for the ⋯ and a right-click, which opens it at the pointer and leaves the focus where it was
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { key: pinKey, anchor, point, previousFocus });
    return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}${filterContext ? " is-filter-context" : ""}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id} data-pin-key={pinKey} data-depth={depth > 0 ? depth : undefined} data-more={line?.more ? "" : undefined} data-through={line?.through ? "" : undefined} hidden={hidden || undefined}
      onMouseDownCapture={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
      onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
      <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}
        onPointerDown={(event) => { if (event.button === 0 && !event.ctrlKey && online && !selected && pane.agent != null) pressPane?.(machine.id, pane.pane_id); }}
        draggable={online}
        // dropped on the pane area, the row opens its pane in half of it (lib/split.ts)
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId: machine.id, paneId: pane.pane_id }));
        }}>
        {missingContext && <span className="visually-hidden">{missingContext} · </span>}
        {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
        <AgentRowBody mark={mark} markKind={markKind} title={title} name={name} context={context} tokens={tokens} backgroundTasks={online ? pane.background_tasks : 0} plan={online ? pane.plan : undefined} paneContext={online && settings.sidebarContext ? pane.context : undefined} status={status} note={filterContext && selected ? t("Selected") : null} muted={muted?.includes(paneMuteKey(machine.id, pane.pane_id)) === true} locked={locked.has(pinKey)} blockedNote={blocked} blockedLabel={blockedShort} progress={online ? pane.agent_progress : undefined} helper={depth > 0} since={waitedFor(pinKey, status)} />
      </button>
      <div className="agent-actions">
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup={sheet ? "dialog" : "menu"} aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
    </li>;
  };

  // no PCs yet (the roster is still on its way), or a connected PC whose panes have not come in: not "none running"
  const loading = machines.length === 0 || machines.some((machine) => machine.state === "connected" && machine.snapshot === null);
  // the empty list's line is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  // under the filter an empty list is the filter's doing, which the list above says once (MachineSidebar.tsx)
  const shownEmpty = useAnnouncedText(rows.length === 0 && !filter.active ? (loading ? t("Loading agents…") : t("No agents running")) : null);
  const menuPinned = menu !== null && pinned.includes(menu.key);
  const menuLocked = menu !== null && locked.has(menu.key);
  const menuShown = menuRow === undefined ? null : describe(menuRow);
  // a phone has no tooltip: its sheet says a blocked agent's whole reason, as the row's tooltip does
  const menuBlocked = menuRow !== undefined && menuShown?.online && activity.status(menuRow.machine.id, menuRow.entry.pane) === "blocked" ? blockedNote(menuRow.entry.pane, t) : null;
  const menuMuted = menuRow !== undefined && muted !== null && muted.includes(paneMuteKey(menuRow.machine.id, menuRow.entry.pane.pane_id));
  // the group the open row is drawn in, and the one it was put in itself (a helper may only follow its agent's)
  const menuGroup = menuRow === undefined || groupNames.length === 0 ? null : rowAgentGroup(menuRow, settings.agentGroupOf, groupNames, allRows);
  // a background agent stays in its own part (whatever its state), so it is offered no group
  const menuBackground = menuRow !== undefined && groupNames.length > 0 && splitBackgroundRows([menuRow], () => undefined, allRows).background.length > 0;
  const menuOwnGroup = menu === null ? undefined : settings.agentGroupOf[menu.key];
  const setGroup = (key: string, name: string | null): void => {
    // as the pins: the groups of panes gone from a loaded PC leave with this change, and no other PC's
    const kept = liveGroupKeys(settings.agentGroupOf, machines, hidden);
    const next = assignAgentGroup(settings.agentGroupOf, key, name, (held) => kept.has(held));
    if (next === null) return;
    updateSettings({ agentGroupOf: next });
    // a row moved into a folded group opens it, so the row and the focus the menu hands back stay in sight
    if (name !== null && groupFolds.includes(name)) toggleGroupFold(name);
  };
  const toggleGroupFold = (name: string): void => {
    const next = groupFolds.includes(name) ? groupFolds.filter((held) => held !== name) : [...groupFolds, name];
    setGroupFolds(next);
    saveFoldedAgentGroups(next);
  };
  // a named group's heading: its fold (none under the filter, which shows what it kept), the states that ask for a look, its count
  const namedGroupLabel = (name: string | null, groupRows: readonly AgentRow[]) => {
    const foldKey = name ?? "";
    const groupFolded = !filter.active && groupFolds.includes(foldKey);
    const states = groupRows.map((row) => agentGroup(rowStatus(row)));
    const blockedCount = states.filter((state) => state === "blocked").length;
    const workingCount = states.filter((state) => state === "working").length;
    return <li className="agent-named-group-label" key={`named:${foldKey}`} data-named-group={foldKey}>
      <button type="button" className="agent-named-group-toggle" aria-expanded={!groupFolded} disabled={filter.active} onClick={() => toggleGroupFold(foldKey)}>
        {groupFolded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
        <span className="agent-named-group-name">{name ?? t("No group")}</span>
        {blockedCount > 0 && <span className="agent-named-group-dot" data-state="blocked" title={t("{count} need you", { count: blockedCount })}><span className="visually-hidden">{t("{count} need you", { count: blockedCount })}</span></span>}
        {workingCount > 0 && <span className="agent-named-group-dot" data-state="working" title={t("{count} working", { count: workingCount })}><span className="visually-hidden">{t("{count} working", { count: workingCount })}</span></span>}
        <span className="agent-section-count">{groupRows.length}</span>
      </button>
    </li>;
  };
  // the rows of the list's people part: in named groups, in state groups, or as they come
  const peopleItems = named !== null
    // with every row in no group, the list draws no heading at all, as today
    ? named.length === 1 && named[0]!.name === null ? listItems(named[0]!.rows)
      : named.flatMap(({ name, rows: groupRows }) => {
        const groupFolded = !filter.active && groupFolds.includes(name ?? "");
        return [namedGroupLabel(name, groupRows), ...listItems(groupRows, groupFolded)];
      })
    : groups ? groups.flatMap(({ group, rows: groupRows }) => [
      <li className="agent-group-label" key={`group:${group}`} data-group={group} aria-hidden="true"><span>{groupLabel(group, t)}</span><span className="agent-group-count">{groupRows.length}</span></li>,
      ...listItems(groupRows),
    ]) : restingFold && named === null && groups === null ? (() => {
      // one line, waiting first: the agents that wait or work stay; the resting ones (idle, finished) fold under one line, a selected one in sight
      const inActive = (row: AgentRow) => holding ? held.current?.active.has(rowKey(row)) === true : busy(row);
      const active = shownPeople.filter(inActive);
      const resting = shownPeople.filter((row) => !inActive(row));
      const restingCount = shownPeople.filter((row) => !busy(row)).length;
      if (resting.length === 0) return listItems(shownPeople);
      const isSelected = (row: AgentRow) => row.machine.id === selectedMachineId && row.entry.pane.pane_id === selectedPaneId;
      return [...listItems(active),
        <li className="agent-background-label agent-resting-label" key="resting">
          <button type="button" className="agent-background-toggle" aria-expanded={restingShown} onClick={() => {
            // under the filter the fold is the filter's, for its time; else the reader's own, kept on this device
            if (filter.active) { setRestingFilterOpen(!restingShown); return; }
            toggleResting();
          }}>
            {restingShown ? <ChevronDown className="agent-section-caret" aria-hidden="true" /> : <ChevronRight className="agent-section-caret" aria-hidden="true" />}
            <span>{t("+{n} resting", { n: restingCount })}</span>
          </button>
        </li>,
        ...resting.flatMap((row) => listItems([row], !restingShown && !isSelected(row)))];
    })() : listItems(shownPeople);
  const runPin = (state: PinMenu): void => {
    // where the menu hands the focus back (lib RowMenu): the ⋯ itself unless the right-click said otherwise
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    const control = back?.closest(`.agent-item[data-pin-key="${CSS.escape(state.key)}"]`) ? back.classList.contains("row-menu-toggle") ? "row-menu-toggle" : "agent-select" : null;
    if (control) refocusPin.current = { key: state.key, control };
    togglePin(state.key);
  };
  // Settings -> Sidebar rows -> One line: an agent row is one line too, its place dim after its title
  const oneLine = settings.sidebarRows === "one";
  // the folded list still says how many of its agents wait for the reader (G-016), in the head's own words
  const waiting = allRows.filter((row) => rowStatus(row) === "blocked").length;
  return <section ref={sectionRef} onPointerEnter={() => setPointerIn(true)} onPointerLeave={() => setPointerIn(false)} onTouchEnd={holdAfterTouch} onTouchCancel={holdAfterTouch} onFocus={() => setFocusIn(true)} onBlur={(event) => { if (!(typeof Node === "function" && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusIn(false); }} className={`agents-sidebar${folded ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}${oneLine ? " is-one-line is-compact" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!folded} aria-controls={listId} onClick={() => {
      // the filter's fold lasts for the filter's time and is never kept; the reader's own is
      if (filter.active) { setFilterFold(!folded); return; }
      setCollapsed(!collapsed);
      try { window.localStorage.setItem(FOLD_KEY, collapsed ? "0" : "1"); } catch { /* private mode: this page keeps it */ }
    }}>
      {folded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {folded && waiting > 0 && <span className="agent-section-waiting">{t("{count} need you", { count: waiting })}</span>}
      {/* the count is of the agents running, filter or not, open or folded */}
      {allRows.length > 0 && !compact && <span className="agent-section-count">{allRows.length}</span>}
    </button>
    <div ref={listRef} className="agent-list-contents" id={listId} hidden={folded}>
      <p className={shownEmpty === null ? "visually-hidden" : "agent-empty"} role="status">{shownEmpty}</p>
      {rows.length > 0 && <>
        {split.pinned.length > 0 && <>
          <p className="sidebar-pinned-label" aria-hidden="true"><span><Pin />{t("Pinned")}</span></p>
          <ul className="agent-list agent-list-pinned sidebar-pinned" aria-label={t("Pinned")}>{split.pinned.map((row) => agentItem(row))}</ul>
        </>}
        {/* one list, so a row that changes groups or parts is moved, not drawn anew: its focus and open menu stay with it */}
        {(parts.people.length > 0 || parts.background.length > 0) && <ul className={`agent-list${groups || named ? " agent-list-grouped" : ""}`}>
          {/* one array of children: React moves a keyed row only among the siblings of its own array */}
          {[...peopleItems,
          ...parts.background.length === 0 ? [] : [
            <li className="agent-background-label" key="background">
              <button type="button" className="agent-background-toggle" aria-expanded={!backgroundFolded} onClick={() => {
                if (filter.active) { setBackgroundFilterFold(!backgroundFolded); return; }
                setBackgroundCollapsed(!backgroundCollapsed);
                try { window.localStorage.setItem(BACKGROUND_FOLD_KEY, backgroundCollapsed ? "0" : "1"); } catch { /* private mode: this page keeps it */ }
              }}>
                {backgroundFolded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
                {compact ? <span>{t("+{n} background", { n: parts.background.length })}</span>
                  : <><span>{t("Background agents")}</span><span className="agent-section-count">{parts.background.length}</span></>}
              </button>
            </li>,
            ...listItems(parts.background, backgroundFolded),
          ]]}
        </ul>}
      </>}
    </div>
    {/* the menu names the agent it is for above its items (G-022): the popover covers the row */}
    {menu && menuShown && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menuShown.title} subtitle={menuShown.place} detail={[menuBlocked, ...menuShown.tokens].filter(Boolean).join(" · ") || undefined} onClose={closeMenu}
      header={<span className="row-menu-target"><span className="row-menu-target-name" title={menuShown.title}>{menuShown.title}</span>{menuShown.place && <span className="row-menu-target-place" title={menuShown.place}>{menuShown.place}</span>}</span>}
      items={[
      // a locked row keeps its pin until it is unlocked
      ...(menuLocked ? [] : [menuPinned
        ? { id: "unpin", label: t("Unpin agent"), icon: PinOff, run: () => runPin(menu) }
        : { id: "pin", label: t("Pin agent"), icon: Pin, run: () => runPin(menu) }]),
      // only a pinned row locks: this app then offers no close for its pane or its tab (lib/paneLocks.ts)
      // Settings -> Lock pinned agents (experimental), off until chosen
      ...(!menuPinned || !settings.agentLocks ? [] : [{
        // a watching device sends no settings: it sees the lock and cannot change it, as with Mute alerts
        id: menuLocked ? "unlock" : "lock", label: menuLocked ? t("Unlock agent") : t("Lock agent"), icon: menuLocked ? LockOpen : Lock, disabled: watching,
        run: () => updateSettings({ lockedAgents: toggleAgentLock(settings.lockedAgents, pinned, menu.key) }),
      }]),
      // Settings -> Named agent groups: into each other group, and out of the one it was put in; a watching device sends no settings
      ...(menuRow === undefined || menuBackground ? [] : groupNames.filter((name) => name !== menuGroup).map((name) => ({
        id: `group:${name}`, label: t("Move to {group}", { group: name }), icon: FolderInput, disabled: watching,
        run: () => setGroup(menu.key, name),
      }))),
      ...(menuOwnGroup === undefined || menuBackground || !groupNames.includes(menuOwnGroup) ? [] : [{
        id: "ungroup", label: t("Remove from {group}", { group: menuOwnGroup }), icon: FolderOutput, disabled: watching,
        run: () => setGroup(menu.key, null),
      }]),
      // one switch for every alert channel and every browser (lib/paneMutes.ts); a watching device sees its state and cannot flip it
      ...(muted === null || menuRow === undefined ? [] : [{
        id: "mute", label: menuMuted ? t("Unmute alerts") : t("Mute alerts"), icon: menuMuted ? Bell : BellOff, checked: menuMuted, disabled: watching,
        run: () => toggleMute(menuRow.machine.id, menuRow.entry.pane.pane_id),
      }]),
    ]} />}
  </section>;
}
