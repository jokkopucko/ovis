import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bell, BellOff, ChevronDown, ChevronRight, Ellipsis, FolderInput, FolderOutput, Lock, LockOpen, Pause, Pin, PinOff, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { paneTokenValues } from "../../shared/pane-tokens.ts";
import type { AgentStatus, HerdrPane, PaneContext, PlanSummary, TabInfo } from "../../shared/protocol.ts";
import { currentAgentRowTokens, subscribeAgentRowTokens } from "../lib/agentRowTokens.ts";
import { holdAcpChildren } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { useEdgeFades } from "../lib/useEdgeFades.ts";
import { AGENT_GROUPS, agentFamilies, agentGroup, agentRoster, groupAgentRows, splitBackgroundRows, type AgentGroup, type AgentRow } from "../lib/agentRoster.ts";
import { stampState, stateSince } from "../lib/agentStateSince.ts";
import { useAgentStateStamps } from "../lib/useAgentStateSince.ts";
import { knownStatus } from "../lib/status.ts";
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
  mark: string | null;
  markKind: string | null;
  title: string;
  name: string | null;
  context: string;
  /** what herdr plugins report on the pane (`$name` tokens), in the order herdr's rows draw them */
  tokens: readonly string[];
  backgroundTasks?: number;
  plan?: PlanSummary;
  paneContext?: PaneContext | undefined;
  status?: AgentStatus;
  note?: string | null;
  muted: boolean;
  locked?: boolean;
  /** why a blocked agent waits, in the agent's own report (herdr-core's OSC 7501 kind and message) */
  blockedNote?: string | null;
  blockedLabel?: string | null;
  /** how far the agent says it is, 0 to 100 (herdr-core's OSC 7501 progress) */
  progress?: number;
  helper?: boolean;
  since?: string | null;
  /** a person stopped this ACP child (HerdrPane `acp_hold`) */
  held?: boolean;
}

/** How long a row has been in its state, as herdr-app's agent rows say it: under a minute, minutes, hours, days. */
export function stateAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function blockedNote(pane: Pick<HerdrPane, "agent_kind" | "agent_message">, t: (key: string) => string): string | null {
  const kind = pane.agent_kind === "permission" ? t("Needs permission")
    : pane.agent_kind === "question" ? t("Has a question")
    : pane.agent_kind === "auth" ? t("Needs sign-in")
    : pane.agent_kind || null;
  const message = pane.agent_message?.trim() || null;
  return kind && message ? `${kind}: ${message}` : kind ?? message;
}

export function blockedLabel(pane: Pick<HerdrPane, "agent_kind" | "agent_message">, t: (key: string) => string): string | null {
  if (pane.agent_kind) return blockedNote({ agent_kind: pane.agent_kind }, t);
  return pane.agent_message?.trim() || null;
}

function AgentRowBody({ mark, markKind, title, name, context, tokens, backgroundTasks, plan, paneContext, status, note = null, muted, locked = false, blockedNote: blocked = null, blockedLabel: blockedShort = null, progress, helper = false, since = null, held = false }: AgentRowBodyProps) {
  const t = useT();
  const showProgress = progress !== undefined && (status === "working" || status === "blocked");
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      {markKind && <span className="visually-hidden">{markKind}: </span>}
      <span className="agent-main">
        <span className="agent-title-line">
          <span className="agent-title">{title}</span>
          {status === "blocked" && blockedShort && <span className="agent-blocked" aria-hidden={blocked !== null && blocked !== blockedShort ? "true" : undefined}>{blockedShort}</span>}
          {status === "blocked" && blocked !== null && blocked !== blockedShort && <span className="visually-hidden">{blocked}</span>}
          {held && <span className="agent-held" title={t("Stopped by you. The agent that called it cannot give it new work.")}>{t("Stopped")}</span>}
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
    <span className="agent-row-state"><StatusBadge status={status} compact detail={status === "blocked" ? blocked : null} /></span>
  </>;
}

export interface AgentSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  stateWord(machine: Machine): string;
  /** this device only watches: it sees the shared mutes and cannot change them */
  watching?: boolean;
  foldRequest?: { folded: boolean; seq: number } | null;
  listId?: string;
  onSelect(machineId: string, paneId: string): void;
}

function rowTitle({ pane, agent }: AgentRow["entry"]): string {
  return pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
}

function markNames(entry: AgentRow["entry"]): string[] {
  const mark = paneMark(entry);
  return mark && hasAgentMark(mark) && entry.canonicalAgent ? [entry.canonicalAgent, agentName(entry.canonicalAgent)] : [];
}

function workspaceTabs({ machine, entry }: AgentRow): TabInfo[] {
  return machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === entry.workspace.workspace_id) ?? [];
}

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
  return { own, title, replaced, drawn: worktree && named === workspace.label ? compactWorktreeName(named) : named };
}

function groupLabel(group: AgentGroup, t: (key: string) => string): string {
  switch (group) {
    case "blocked": return t("Needs you");
    case "working": return t("Working");
    case "done": return t("Done");
    case "idle": return t("Idle");
  }
}

const DRAWER_QUERY = "(max-width: 768px)";
const FOLD_KEY = "ovis:agents-collapsed";
const STOP_ERROR_MS = 5000;

const RESTING_OPEN_KEY = "ovis:agents-resting-open";

const BACKGROUND_FOLD_KEY = "ovis:agents-background-collapsed";

const HELPERS_OPEN_KEY = "ovis:agents-helpers-open";

function foldControlAbove(item: Element): HTMLButtonElement | null {
  for (let above = item.previousElementSibling; above; above = above.previousElementSibling) {
    if (above.hasAttribute("hidden")) continue;
    if (!above.matches(".agent-helpers, .agent-named-group-label, .agent-group-label, .agent-background-label")) continue;
    const button = above.querySelector("button");
    if (button?.getAttribute("aria-expanded") !== "true") return button;
  }
  return null;
}

const STATE_FOLDS_KEY = "ovis:agent-state-folds";
const FOLDED_AT_FIRST: readonly AgentGroup[] = ["idle"];

function keptStateFolds(): AgentGroup[] | null {
  try {
    const kept = window.localStorage.getItem(STATE_FOLDS_KEY);
    const stored: unknown = kept === null ? null : JSON.parse(kept);
    return Array.isArray(stored) ? AGENT_GROUPS.filter((group) => stored.includes(group)) : null;
  } catch {
    return null;
  }
}

function loadStateFolds(): AgentGroup[] {
  return keptStateFolds() ?? [...FOLDED_AT_FIRST];
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

function initialFold(): boolean {
  try {
    const stored = window.localStorage.getItem(FOLD_KEY);
    if (stored === "1" || stored === "0") return stored === "1";
  } catch {}
  return window.matchMedia?.(DRAWER_QUERY).matches === true;
}
interface PinMenu { key: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null }

export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, watching = false, foldRequest = null, listId: givenListId, onSelect }: AgentSidebarProps) {
  const t = useT();
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
  const pinned = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const muted = useSyncExternalStore(subscribePaneMutes, currentPaneMutes, currentPaneMutes);
  const locked = useMemo(() => lockedPinKeys(settings.lockedAgents, pinned, settings.agentLocks), [settings.lockedAgents, pinned, settings.agentLocks]);
  // which `$name` tokens herdr's own sidebar draws, from this server's herdr config (server/herdr-sidebar.ts)
  const rowTokens = useSyncExternalStore(subscribeAgentRowTokens, currentAgentRowTokens, currentAgentRowTokens);
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity across PCs using the hub's change times;
  // the pinned rows stand first, in the order they were pinned (lib/agentRoster.ts)
  const byActivity = settings.agentOrder === "activity" && !settings.agentGroups;
  const roster = useMemo(() => agentRoster(machines, { byActivity, seqs: activity.seqs, pinned }), [machines, byActivity, activity, pinned]);
  const allRows = useMemo(() => [...roster.pinned, ...roster.rest], [roster]);
  const { filter } = useSidebarFilter();
  const split = useMemo(() => {
    if (!filter.active) return roster;
    const kept = ({ machine, entry }: AgentRow): boolean => machineFilter(filter, machine.id)?.panes.has(entry.pane.pane_id) === true;
    return { pinned: roster.pinned.filter(kept), rest: roster.rest.filter(kept) };
  }, [roster, filter]);
  const rows = useMemo(() => [...split.pinned, ...split.rest], [split]);
  const parts = useMemo(() => splitBackgroundRows(split.rest, ({ machine, entry }) => machine.state === "connected" ? activity.status(machine.id, entry.pane) : undefined, allRows), [split, activity, allRows]);
  const rowStatus = useCallback(({ machine, entry }: AgentRow) => machine.state === "connected" ? activity.status(machine.id, entry.pane) : undefined, [activity]);
  const byState = useCallback((list: readonly AgentRow[]) => groupAgentRows(list, {
    sort: settings.agentGroupSort,
    status: rowStatus,
    name: (row) => agentRowTitle(row, settings.sidebarRows === "one").drawn,
    seqs: activity.seqs,
  }), [settings.agentGroupSort, settings.sidebarRows, rowStatus, activity]);
  const groupNames = settings.agentNamedGroups ? settings.agentGroupNames : [];
  const named = useMemo(() => groupNames.length === 0 ? null : splitNamedGroups(parts.people, settings.agentGroupOf, groupNames, allRows)
    .map(({ name, rows: groupRows }) => ({ name, rows: settings.agentGroups ? byState(groupRows).flatMap((group) => group.rows) : groupRows })),
  [groupNames, settings.agentGroupOf, settings.agentGroups, parts, allRows, byState]);
  const groups = useMemo(() => !settings.agentGroups || named !== null ? null : byState(parts.people), [settings.agentGroups, named, parts, byState]);
  const compact = settings.sidebarRows === "one";
  const restingFold = compact && settings.agentOrder === "waiting";
  const [restingOpen, setRestingOpen] = useState(() => { try { return window.localStorage.getItem(RESTING_OPEN_KEY) === "1"; } catch { return false; } });
  const toggleResting = (): void => {
    setRestingOpen(!restingOpen);
    try { window.localStorage.setItem(RESTING_OPEN_KEY, restingOpen ? "0" : "1"); } catch {}
  };
  const people = useMemo(() => {
    if (settings.agentOrder !== "waiting" || groups !== null || named !== null) return parts.people;
    const families = agentFamilies(parts.people);
    const waits = (family: AgentRow[]) => family.some((row) => rowStatus(row) === "blocked");
    return [...families.filter(waits), ...families.filter((family) => !waits(family))].flat();
  }, [settings.agentOrder, groups, named, parts, rowStatus]);
  const stamps = useAgentStateStamps();
  useEffect(() => { setNow(Date.now()); }, [stamps]);
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
  const [stateFolds, setStateFolds] = useState(loadStateFolds);
  const toggleStateFold = (group: AgentGroup): void => {
    const others = (keptStateFolds() ?? stateFolds).filter((held) => held !== group);
    const next = stateFolds.includes(group) ? others : AGENT_GROUPS.filter((held) => held === group || others.includes(held));
    setStateFolds(next);
    try { window.localStorage.setItem(STATE_FOLDS_KEY, JSON.stringify(next)); } catch {}
  };
  const [groupFolds, setGroupFolds] = useState(loadFoldedAgentGroups);
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
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
  // the times tick only while the list is open and a row has one to draw. The clock stands still meanwhile, so it is
  // set as its updates start again, before the list is painted: an opened list says its times as of now, where the
  // first tick would come half a minute later
  const shouldTick = !folded && Object.values(stamps).some((pc) => Object.keys(pc.rows).length > 0);
  const ticked = useRef(shouldTick);
  useLayoutEffect(() => {
    if (shouldTick && !ticked.current) setNow(Date.now());
    ticked.current = shouldTick;
  }, [shouldTick]);
  useEffect(() => { setTicking(shouldTick); }, [shouldTick]);
  const readerKey = [filter.query, restingShown, selectedMachineId, selectedPaneId, ...pinned].join("\n");
  const held = useRef<{ readerKey: string; order: readonly string[]; active: ReadonlySet<string> } | null>(null);
  const holding = (pointerIn || focusIn || touchHeld) && held.current?.readerKey === readerKey;
  const rowKey = (row: AgentRow) => sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
  const busy = (row: AgentRow) => { const status = rowStatus(row); return status === "blocked" || status === "working" || status === "waiting"; };
  useEffect(() => {
    if (holding) return;
    // what stands above the resting line is held by family: a helper leaving or ending keeps its agent in place
    held.current = { readerKey, order: people.map(rowKey), active: new Set(agentFamilies(people).filter((family) => family.some(busy)).flat().map(rowKey)) };
  });
  const heldOrder = holding ? held.current?.order : undefined;
  // the order drawn, which the tree lines below are read from too
  const shownPeople = useMemo(() => {
    if (heldOrder === undefined) return people;
    // a row that came during the hold takes the place of its nearest held ancestor, so a new helper stands with its agent
    const byKey = new Map(people.map((row) => [rowKey(row), row]));
    const at = (row: AgentRow): number => {
      const passed = new Set<AgentRow>();
      for (let up: AgentRow | undefined = row; up && !passed.has(up); up = up.entry.pane.parent_pane_id === undefined ? undefined : byKey.get(sidebarPinKey(up.machine.id, up.entry.pane.parent_pane_id))) {
        const index = heldOrder.indexOf(rowKey(up));
        if (index >= 0) return index;
        passed.add(up);
      }
      return Number.MAX_SAFE_INTEGER;
    };
    const places = new Map(people.map((row) => [row, at(row)]));
    const sorted = [...people].sort((a, b) => places.get(a)! - places.get(b)!);
    // the same order is the same list: the tree lines and folds below are not drawn again for a hold alone
    return sorted.every((row, index) => row === people[index]) ? people : sorted;
  }, [people, heldOrder]);
  useEffect(() => {
    if (foldRequest === null || foldRequest.folded === folded) return;
    if (filter.active) { setFilterFold(foldRequest.folded); return; }
    setCollapsed(foldRequest.folded);
    try { window.localStorage.setItem(FOLD_KEY, foldRequest.folded ? "1" : "0"); } catch {}
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
    if (muted !== null) setPaneMutes(togglePaneMute(prunePaneMutes(muted, machines), paneMuteKey(machineId, paneId)));
  };
  const sectionRef = useRef<HTMLElement>(null);
  const heldFocus = useRef<Element | null>(null);
  const forgetFocus = (left: Element): void => { queueMicrotask(() => { if (heldFocus.current === left) heldFocus.current = null; }); };
  const listRef = useRef<HTMLDivElement>(null);
  useEdgeFades(listRef);
  const refocusPin = useRef<{ key: string; control: string } | null>(null);
  useLayoutEffect(() => {
    const target = refocusPin.current;
    if (target === null) return;
    refocusPin.current = null;
    const control = sectionRef.current?.querySelector<HTMLButtonElement>(`.agent-item[data-pin-key="${CSS.escape(target.key)}"] .${target.control}`);
    const item = control?.closest("li");
    (item?.hidden ? foldControlAbove(item) : control)?.focus({ preventScroll: true });
  }, [pinned]);
  const [menu, setMenu] = useState<PinMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuRow = menu === null ? undefined : rows.find(({ machine, entry }) => machine.state !== "disconnected" && machine.state !== "error" && sidebarPinKey(machine.id, entry.pane.pane_id) === menu.key);
  useEffect(() => {
    if (menu && (menuRow === undefined || !menu.anchor.isConnected)) setMenu(null);
  }, [menu, menuRow]);
  // herdr names a PC only beside another: the rows' line does the same
  const machineName = (machine: Machine): string | null => machines.length > 1 && !(settings.sidebarRows === "one" && machine.kind === "local") ? machine.name : null;
  const wholePlace = (machine: Machine, parts: readonly (string | null)[]): string => [...new Set([machines.length > 1 ? machine.name : null, ...parts])].filter((part): part is string => part !== null && part !== "").join(" · ");
  const sheet = useMediaQuery(SHEET_QUERY);

  const describe = (row: AgentRow) => {
    const { machine, entry } = row;
    const { pane, workspace, tab, agent, agentLabel } = entry;
    const online = machine.state === "connected";
    const name = agent?.name?.trim() || null;
    const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
    const tabs = workspaceTabs(row);
    const mark = paneMark(entry);
    const markAgent = mark && hasAgentMark(mark) ? mark : null;
    const { own: said, title, replaced, drawn } = agentRowTitle(row, compact);
    const ownTitle = replaced ? said : null;
    const parts = { agentLabel: kindLabel !== null && titleOnlyNamesAgent(kindLabel, markNames(entry)) ? null : kindLabel, title, markAgent, machineName: machineName(machine), workspaceLabel: workspace.label, tabName: agentTabName(tab, tabs, t) };
    const contextParts = agentContext(parts).filter((part) => part !== title && !(replaced && part === workspace.label));
    const context = contextParts.join(" · ");
    const kind = kindLabel?.trim() || null;
    const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
    const tokens = online ? paneTokenValues(rowTokens, entry.canonicalAgent, pane.tokens ?? agent?.tokens) : [];
    if (compact) {
      const lead = drawn;
      const own = title !== lead && title !== workspace.label ? title : null;
      const leadParts = [...new Set([own, ...agentContext({ ...parts, title: lead, tabName: parts.tabName === lead ? null : parts.tabName, workspaceLabel: workspace.worktree?.is_linked_worktree ? compactWorktreeName(workspace.label) : workspace.label })])].filter((part): part is string => part !== null && part !== lead);
      return { online, title: lead, ownTitle, name, mark, context: leadParts.join(" · "), place: wholePlace(machine, leadParts), markKind: kind && kind !== lead && !leadParts.includes(kind) ? kind : null, tokens };
    }
    return { online, title, ownTitle, name, mark, context, place: wholePlace(machine, contextParts), markKind, tokens };
  };

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
  const foldHelpers = settings.foldHelpers && !filter.active;
  const [openHelpers, setOpenHelpers] = useState(loadOpenHelpers);
  const { restDepths, restLines, helpersOf, foldedHelpers } = useMemo(() => {
    const restDepths = new Map<AgentRow, number>();
    const restLines = new Map<AgentRow, { more: boolean; through: boolean }>();
    const helpersOf = new Map<AgentRow, AgentRow[]>();
    const foldedHelpers = new Set<AgentRow>();
    for (const list of [...named ? named.map((group) => group.rows) : groups ? groups.map((group) => group.rows) : [shownPeople], parts.background]) {
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
      const shown = list.filter((row) => !foldedHelpers.has(row));
      for (const [row, line] of treeLines(shown, listDepths)) restLines.set(row, line);
    }
    return { restDepths, restLines, helpersOf, foldedHelpers };
  }, [parts, shownPeople, groups, named, foldHelpers, openHelpers, selectedMachineId, selectedPaneId, rowStatus]);
  useLayoutEffect(() => {
    const active = document.activeElement;
    const inList = Boolean(active && sectionRef.current?.contains(active));
    const held = heldFocus.current;
    if (!inList) heldFocus.current = null;
    const focused = inList ? active : !active || active === document.body ? held : null;
    const item = focused?.closest("li") ?? null;
    if (item?.hidden) foldControlAbove(item)?.focus({ preventScroll: true });
  }, [foldedHelpers, groups, stateFolds]);
  const toggleHelpers = (key: string): void => {
    const stored = loadOpenHelpers();
    const live = new Set(machines.flatMap((machine) => machine.snapshot?.panes.map((pane) => sidebarPinKey(machine.id, pane.pane_id)) ?? []));
    const kept = pruneSidebarPins(stored.filter((held) => held !== key), live, machines, hidden);
    const next = openHelpers.includes(key) ? kept : [...kept, key];
    setOpenHelpers(next);
    try { window.localStorage.setItem(HELPERS_OPEN_KEY, JSON.stringify(next)); } catch {}
  };
  const helpersLine = (agentRow: AgentRow, helpers: readonly AgentRow[], hidden: boolean) => {
    const key = sidebarPinKey(agentRow.machine.id, agentRow.entry.pane.pane_id);
    const open = openHelpers.includes(key);
    const states = helpers.map((row) => agentGroup(rowStatus(row)));
    const blockedCount = states.filter((state) => state === "blocked").length;
    const workingCount = states.filter((state) => state === "working").length;
    const more = helpers.some((row) => !foldedHelpers.has(row));
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
  const listItems = (list: readonly AgentRow[], hidden = false, group?: AgentGroup) => list.flatMap((row) => {
    const item = agentItem(row, hidden || foldedHelpers.has(row), group);
    const helpers = helpersOf.get(row);
    return helpers === undefined ? [item] : [item, helpersLine(row, helpers, hidden)];
  });

  const agentItem = (row: AgentRow, hidden = false, group?: AgentGroup) => {
    const { machine, entry } = row;
    const { pane, agent } = entry;
    const depth = Math.min(2, restDepths.get(row) ?? 0);
    const line = restLines.get(row);
    const parentRow = depth > 0 ? allRows.find((candidate) => candidate.machine.id === machine.id && candidate.entry.pane.pane_id === pane.parent_pane_id) : undefined;
    const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
    const filterContext = filter.active && machineFilter(filter, machine.id)?.matchedPanes.has(pane.pane_id) !== true;
    const { online, title, ownTitle, name, mark, context, place, markKind, tokens } = describe(row);
    const spoken = [title, markKind, ...(depth > 0 ? [] : [name, ...context.split(" · ")])];
    const missingContext = [entry.canonicalAgent, entry.workspace.label, machine.name].filter((part) => part && !spoken.includes(part)).join(" · ");
    const blocked = online ? blockedNote(pane, t) : null;
    const blockedShort = online ? blockedLabel(pane, t) : null;
    const startedBy = parentRow ? t("Started by {name}", { name: describe(parentRow).title }) : null;
    const status = online ? activity.status(machine.id, pane) : undefined;
    const progress = online && pane.agent_progress !== undefined && (status === "working" || status === "blocked") ? t("Progress {percent}%", { percent: pane.agent_progress }) : null;
    const stateBegan = online ? stateSince(stamps, machine.id, pane.pane_id, pane.terminal_id, stampState(agentGroup(status))) : null;
    const since = stateBegan === null ? null : stateAge(Math.max(0, now - stateBegan));
    const tooltip = [...new Set([pane.pane_id, title, ownTitle, agent?.title?.trim(), place, machines.length === 1 ? machine.name : null, startedBy, blocked, progress, ...tokens, markKind, name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
    const pinKey = sidebarPinKey(machine.id, pane.pane_id);
    const menuOpen = menu?.key === pinKey;
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { key: pinKey, anchor, point, previousFocus });
    const stateSaid = group !== undefined && knownStatus(status) === group;
    return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}${filterContext ? " is-filter-context" : ""}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id} data-pin-key={pinKey} data-depth={depth > 0 ? depth : undefined} data-more={line?.more ? "" : undefined} data-through={line?.through ? "" : undefined} hidden={hidden || undefined}
      data-state-said={stateSaid ? "" : undefined}
      data-state-own={group !== undefined && !stateSaid ? "" : undefined}
      onMouseDownCapture={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
      onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
      <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}
        onPointerDown={(event) => { if (event.button === 0 && !event.ctrlKey && online && !selected && pane.agent != null) pressPane?.(machine.id, pane.pane_id); }}
        draggable={online}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId: machine.id, paneId: pane.pane_id }));
        }}>
        {missingContext && <span className="visually-hidden">{missingContext} · </span>}
        <AgentRowBody mark={mark} markKind={markKind} title={title} name={name} context={context} tokens={tokens} backgroundTasks={online ? pane.background_tasks : 0} plan={online ? pane.plan : undefined} paneContext={online && settings.sidebarContext ? pane.context : undefined} status={status} note={filterContext && selected ? t("Selected") : null} muted={muted?.includes(paneMuteKey(machine.id, pane.pane_id)) === true} locked={locked.has(pinKey)} blockedNote={blocked} blockedLabel={blockedShort} progress={online ? pane.agent_progress : undefined} helper={depth > 0} since={since} held={online && pane.acp_hold !== undefined} />
      </button>
      <div className="agent-actions">
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup={sheet ? "dialog" : "menu"} aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
    </li>;
  };

  const loading = machines.length === 0 || machines.some((machine) => machine.state === "connected" && machine.snapshot === null);
  // the empty list's line is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  const shownEmpty = useAnnouncedText(rows.length === 0 && !filter.active ? (loading ? t("Loading agents…") : t("No agents running")) : null);
  const menuPinned = menu !== null && pinned.includes(menu.key);
  const menuLocked = menu !== null && locked.has(menu.key);
  const menuShown = menuRow === undefined ? null : describe(menuRow);
  // a phone has no tooltip: its sheet says a blocked agent's whole reason, as the row's tooltip does
  const menuBlocked = menuRow !== undefined && menuShown?.online && activity.status(menuRow.machine.id, menuRow.entry.pane) === "blocked" ? blockedNote(menuRow.entry.pane, t) : null;
  const menuMuted = menuRow !== undefined && muted !== null && muted.includes(paneMuteKey(menuRow.machine.id, menuRow.entry.pane.pane_id));
  const menuGroup = menuRow === undefined || groupNames.length === 0 ? null : rowAgentGroup(menuRow, settings.agentGroupOf, groupNames, allRows);
  const menuBackground = menuRow !== undefined && groupNames.length > 0 && splitBackgroundRows([menuRow], () => undefined, allRows).background.length > 0;
  const menuOwnGroup = menu === null ? undefined : settings.agentGroupOf[menu.key];
  // the ACP children the menu's agent started that still take new work from it: a person's Stop holds them all
  const menuCalled = menuRow === undefined ? 0 : (menuRow.machine.snapshot?.panes ?? []).filter((pane) => pane.acp_child === true && pane.acp_hold === undefined && pane.parent_pane_id === menuRow.entry.pane.pane_id).length;
  const [stopError, setStopError] = useState<string | null>(null);
  useEffect(() => {
    if (stopError === null) return;
    const timer = window.setTimeout(() => setStopError(null), STOP_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [stopError]);
  const stopCalled = (row: AgentRow): void => {
    const failed = t("Some agents it called were not stopped. Try again.");
    void holdAcpChildren(row.entry.pane.pane_id, row.machine.id).then(({ failed: panes }) => { if (panes.length > 0) setStopError(failed); }, () => setStopError(failed));
  };
  const setGroup = (key: string, name: string | null): void => {
    const kept = liveGroupKeys(settings.agentGroupOf, machines, hidden);
    const next = assignAgentGroup(settings.agentGroupOf, key, name, (held) => kept.has(held));
    if (next === null) return;
    updateSettings({ agentGroupOf: next });
    if (name !== null && groupFolds.includes(name)) toggleGroupFold(name);
  };
  const toggleGroupFold = (name: string): void => {
    const next = groupFolds.includes(name) ? groupFolds.filter((held) => held !== name) : [...groupFolds, name];
    setGroupFolds(next);
    saveFoldedAgentGroups(next);
  };
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
  const isSelected = (row: AgentRow) => row.machine.id === selectedMachineId && row.entry.pane.pane_id === selectedPaneId;
  const peopleItems = named !== null
    ? named.length === 1 && named[0]!.name === null ? listItems(named[0]!.rows)
      : named.flatMap(({ name, rows: groupRows }) => {
        const groupFolded = !filter.active && groupFolds.includes(name ?? "");
        return [namedGroupLabel(name, groupRows), ...listItems(groupRows, groupFolded)];
      })
    : groups ? groups.flatMap(({ group, rows: groupRows }) => {
      const groupFolded = !filter.active && stateFolds.includes(group);
      return [
        <li className="agent-group-label" key={`group:${group}`} data-group={group}>
          <button type="button" className="agent-group-toggle" aria-expanded={!groupFolded} disabled={filter.active} onClick={() => toggleStateFold(group)}>
            {groupFolded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
            <span className="agent-group-name">{groupLabel(group, t)}</span>
            <span className="agent-group-count">{groupRows.length}</span>
          </button>
        </li>,
        ...groupRows.flatMap((row) => listItems([row], groupFolded && !isSelected(row), group)),
      ];
    }) : restingFold && named === null && groups === null ? (() => {
      // a helper stays with the agent that started it: a family is above the line while any of it is
      const inActive = (row: AgentRow) => holding ? held.current?.active.has(rowKey(row)) === true : busy(row);
      const families = agentFamilies(shownPeople);
      const activeFamilies = (rowActive: (row: AgentRow) => boolean) => new Set(families.filter((family) => family.some(rowActive)).flat());
      const above = activeFamilies(inActive);
      const active = shownPeople.filter((row) => above.has(row));
      const resting = shownPeople.filter((row) => !above.has(row));
      const busyNow = activeFamilies(busy);
      const restingCount = shownPeople.filter((row) => !busyNow.has(row)).length;
      if (resting.length === 0) return listItems(shownPeople);
      return [...listItems(active),
        <li className="agent-background-label agent-resting-label" key="resting">
          <button type="button" className="agent-background-toggle" aria-expanded={restingShown} onClick={() => {
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
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    const control = back?.closest(`.agent-item[data-pin-key="${CSS.escape(state.key)}"]`) ? back.classList.contains("row-menu-toggle") ? "row-menu-toggle" : "agent-select" : null;
    if (control) refocusPin.current = { key: state.key, control };
    togglePin(state.key);
  };
  const oneLine = settings.sidebarRows === "one";
  const waiting = allRows.filter((row) => rowStatus(row) === "blocked").length;
  return <section ref={sectionRef} onPointerEnter={() => setPointerIn(true)} onPointerLeave={() => setPointerIn(false)} onTouchEnd={holdAfterTouch} onTouchCancel={holdAfterTouch} onFocus={(event) => { setFocusIn(true); heldFocus.current = event.target; }} onBlur={(event) => { forgetFocus(event.target); if (!(typeof Node === "function" && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusIn(false); }} className={`agents-sidebar${folded ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}${oneLine ? " is-one-line is-compact" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!folded} aria-controls={listId} onClick={() => {
      if (filter.active) { setFilterFold(!folded); return; }
      setCollapsed(!collapsed);
      try { window.localStorage.setItem(FOLD_KEY, collapsed ? "0" : "1"); } catch {}
    }}>
      {folded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {folded && waiting > 0 && <span className="agent-section-waiting">{t("{count} need you", { count: waiting })}</span>}
      {allRows.length > 0 && !compact && <span className="agent-section-count">{allRows.length}</span>}
    </button>
    <div ref={listRef} className="agent-list-contents" id={listId} hidden={folded}>
      <p className={shownEmpty === null ? "visually-hidden" : "agent-empty"} role="status">{shownEmpty}</p>
      {rows.length > 0 && <>
        {split.pinned.length > 0 && <>
          <p className="sidebar-pinned-label" aria-hidden="true"><span><Pin />{t("Pinned")}</span></p>
          <ul className="agent-list agent-list-pinned sidebar-pinned" aria-label={t("Pinned")}>{split.pinned.map((row) => agentItem(row))}</ul>
        </>}
        {(parts.people.length > 0 || parts.background.length > 0) && <ul className={`agent-list${groups || named ? " agent-list-grouped" : ""}`}>
          {/* one array of children: React moves a keyed row only among the siblings of its own array */}
          {[...peopleItems,
          ...parts.background.length === 0 ? [] : [
            <li className="agent-background-label" key="background">
              <button type="button" className="agent-background-toggle" aria-expanded={!backgroundFolded} onClick={() => {
                if (filter.active) { setBackgroundFilterFold(!backgroundFolded); return; }
                setBackgroundCollapsed(!backgroundCollapsed);
                try { window.localStorage.setItem(BACKGROUND_FOLD_KEY, backgroundCollapsed ? "0" : "1"); } catch {}
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
    {stopError !== null && <p className="sidebar-inline-error" role="alert">{stopError}</p>}
    {menu && menuShown && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menuShown.title} subtitle={menuShown.place} alert={menuBlocked ?? undefined} detail={menuShown.tokens.join(" · ") || undefined} onClose={closeMenu}
      header={<span className="row-menu-target"><span className="row-menu-target-name" title={menuShown.title}>{menuShown.title}</span>{menuShown.place && <span className="row-menu-target-place" title={menuShown.place}>{menuShown.place}</span>}</span>}
      items={[
      ...(menuLocked ? [] : [menuPinned
        ? { id: "unpin", label: t("Unpin agent"), icon: PinOff, run: () => runPin(menu) }
        : { id: "pin", label: t("Pin agent"), icon: Pin, run: () => runPin(menu) }]),
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
      ...(menuRow === undefined || menuCalled === 0 ? [] : [{
        id: "stop-called", label: t("Stop agents it called ({count})", { count: menuCalled }), icon: Pause, disabled: watching || menuRow.machine.view_only === true,
        run: () => stopCalled(menuRow),
      }]),
      ...(muted === null || menuRow === undefined ? [] : [{
        id: "mute", label: menuMuted ? t("Unmute alerts") : t("Mute alerts"), icon: menuMuted ? Bell : BellOff, checked: menuMuted, disabled: watching,
        run: () => toggleMute(menuRow.machine.id, menuRow.entry.pane.pane_id),
      }]),
    ]} />}
  </section>;
}
