import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bell, BellOff, ChevronDown, ChevronRight, Ellipsis, Pin, PinOff, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { paneTokenValues } from "../../shared/pane-tokens.ts";
import type { AgentStatus, HerdrPane, PlanSummary } from "../../shared/protocol.ts";
import { currentAgentRowTokens, subscribeAgentRowTokens } from "../lib/agentRowTokens.ts";
import { useT } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { agentRoster, type AgentRow } from "../lib/agentRoster.ts";
import { currentPaneMutes, paneMuteKey, prunePaneMutes, setPaneMutes, subscribePaneMutes, togglePaneMute } from "../lib/paneMutes.ts";
import { agentContext, agentTabName, paneMark } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { machineFilter } from "../lib/sidebarFilter.ts";
import { useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { useHiddenMachines } from "../lib/hiddenMachines.ts";
import { currentSidebarPins, pruneSidebarPins, setSidebarPins, sidebarPinKey, subscribeSidebarPins, toggleSidebarPin } from "../lib/sidebarPins.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { AgentMark, hasAgentMark } from "./AgentMark.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { BackgroundBadge, displayPaneTitle, onRowContextMenu, PlanBadge, StatusBadge } from "./Sidebar.tsx";
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
  status?: AgentStatus;
  /** why a row the filter did not match is drawn all the same: it is the selected one */
  note?: string | null;
  /** its alerts are off for everyone (lib/paneMutes.ts): said beside the state, as a word for a screen reader */
  muted: boolean;
  /** why a blocked agent waits, in the agent's own report (herdr-core's OSC 7501 kind and message) */
  blockedNote?: string | null;
  /** the same reason in a few words, for the row's line (blockedLabel) */
  blockedLabel?: string | null;
  /** how far the agent says it is, 0 to 100 (herdr-core's OSC 7501 progress) */
  progress?: number;
  /** a helper under the agent that started it: one line, its place and plugin values left to the tooltip */
  helper?: boolean;
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
function AgentRowBody({ mark, markKind, title, name, context, tokens, backgroundTasks, plan, status, note = null, muted, blockedNote: blocked = null, blockedLabel: blockedShort = null, progress, helper = false }: AgentRowBodyProps) {
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
      {note !== null && <span className="sidebar-filter-note">{note}</span>}<BackgroundBadge count={backgroundTasks} /><PlanBadge plan={plan} />
      {muted && <span className="agent-muted" title={t("Alerts muted")} data-testid="alerts-muted"><BellOff aria-hidden="true" /><span className="visually-hidden">{t("Alerts muted")}</span></span>}
    </span>
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
  onSelect(machineId: string, paneId: string): void;
}

/** the width under which the sidebar is a drawer (src/styles.css) */
const DRAWER_QUERY = "(max-width: 768px)";
/** the reader's fold of the list, kept on this device as a PC's fold is (MachineSidebar.tsx): a phone and a desktop each keep their own */
const FOLD_KEY = "ovis:agents-collapsed";

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
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, watching = false, onSelect }: AgentSidebarProps) {
  const t = useT();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(initialFold);
  const { settings } = useSettings();
  const pressPane = useContext(PanePressContext);
  // shared with the other browsers of this server (lib/preferencesSync.ts)
  const pinned = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  // the panes whose alerts are off, shared the same way; null on a server that keeps no such list, which then offers no mute
  const muted = useSyncExternalStore(subscribePaneMutes, currentPaneMutes, currentPaneMutes);
  // which `$name` tokens herdr's own sidebar draws, from this server's herdr config (server/herdr-sidebar.ts)
  const rowTokens = useSyncExternalStore(subscribeAgentRowTokens, currentAgentRowTokens, currentAgentRowTokens);
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes);
  // the pinned rows stand first, in the order they were pinned (lib/agentRoster.ts)
  const byActivity = settings.agentOrder === "activity";
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
  // a folded list (a phone's starts so) opens while the filter keeps rows in it, so a match or the selection is
  // seen, not only kept; its caret then folds and opens it for the filter's time, the list's own fold untouched
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
  useEffect(() => { if (!filter.active) setFilterFold(null); }, [filter.active]);
  const folded = filter.active ? filterFold ?? (collapsed && rows.length === 0) : collapsed;
  // the PCs this device hides are not in `machines`: their pins are kept, not taken for gone panes
  const hidden = useHiddenMachines();
  const togglePin = (key: string): void => {
    // pins of panes gone from this server leave with a change of the user's, never by themselves: the
    // list is shared, and a pane this page has not seen yet (a PC still loading) is not gone
    const live = new Set(allRows.map(({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id)));
    setSidebarPins(toggleSidebarPin(pruneSidebarPins(pinned, live, machines, hidden), key));
  };
  const toggleMute = (machineId: string, paneId: string): void => {
    // as the pins: the mutes of panes a connected PC no longer has leave with this change, and no other PC's
    if (muted !== null) setPaneMutes(togglePaneMute(prunePaneMutes(muted, machines), paneMuteKey(machineId, paneId)));
  };
  // a pin moves the row to the other list, so React draws it anew: the control of the row that had
  // the focus (its row or its ⋯) gets it back
  const sectionRef = useRef<HTMLElement>(null);
  const refocusPin = useRef<{ key: string; control: string } | null>(null);
  useLayoutEffect(() => {
    const target = refocusPin.current;
    if (target === null) return;
    refocusPin.current = null;
    sectionRef.current?.querySelector<HTMLButtonElement>(`.agent-item[data-pin-key="${CSS.escape(target.key)}"] .${target.control}`)?.focus({ preventScroll: true });
  }, [pinned]);
  const [menu, setMenu] = useState<PinMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuRow = menu === null ? undefined : rows.find(({ machine, entry }) => machine.state !== "disconnected" && machine.state !== "error" && sidebarPinKey(machine.id, entry.pane.pane_id) === menu.key);
  // a row that left the list or whose PC stopped connecting takes its menu with it; a retry keeps it
  useEffect(() => {
    if (menu && (menuRow === undefined || !menu.anchor.isConnected)) setMenu(null);
  }, [menu, menuRow]);
  // herdr names a PC only beside another: the rows' line does the same
  const machineName = (machine: Machine): string | null => machines.length > 1 ? machine.name : null;

  // what a row says of its agent, for the row and for its open menu
  const describe = ({ machine, entry }: AgentRow) => {
    const { pane, workspace, tab, agent, agentLabel } = entry;
    const online = machine.state === "connected";
    const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
    const name = agent?.name?.trim() || null;
    // the name has its own place on the line: the label beside it says the kind instead
    const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
    const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
    const mark = paneMark(entry);
    const markAgent = mark && hasAgentMark(mark) ? mark : null;
    const parts = { agentLabel: kindLabel, title, markAgent, machineName: machineName(machine), workspaceLabel: workspace.label, tabName: agentTabName(tab, tabs, t) };
    const contextParts = agentContext(parts);
    const context = contextParts.join(" · ");
    const kind = kindLabel?.trim() || null;
    const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
    // a PC that is away says nothing of its agents now, its plugins' words included
    const tokens = online ? paneTokenValues(rowTokens, entry.canonicalAgent, pane.tokens ?? agent?.tokens) : [];
    return { online, title, name, mark, context, markKind, tokens };
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
  // the pinned card keeps the pin order, where a helper need not follow its agent: no row steps in there
  const restDepths = useMemo(() => depths(split.rest), [split]);
  // the tree line of each helper: it runs on (`more`) while a later helper of the same agent follows before a
  // shallower row, and a depth-2 row has its agent's line pass through it (`through`) when that line runs on
  const restLines = useMemo(() => {
    const level = split.rest.map((row) => Math.min(2, restDepths.get(row) ?? 0));
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
    split.rest.forEach((row, index) => {
      if (level[index] === 1) parentMore = more[index]!;
      lines.set(row, { more: more[index]!, through: level[index] === 2 && parentMore });
    });
    return lines;
  }, [split, restDepths]);

  const agentItem = (row: AgentRow) => {
    const { machine, entry } = row;
    const { pane, agent } = entry;
    const depth = Math.min(2, restDepths.get(row) ?? 0);
    const line = restLines.get(row);
    const parentRow = depth > 0 ? allRows.find((candidate) => candidate.machine.id === machine.id && candidate.entry.pane.pane_id === pane.parent_pane_id) : undefined;
    const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
    // under the filter a row it did not match is there for the selection: drawn as context, and said so
    const filterContext = filter.active && machineFilter(filter, machine.id)?.matchedPanes.has(pane.pane_id) !== true;
    const { online, title, name, mark, context, markKind, tokens } = describe(row);
    // the row cuts a long value: the tooltip, and a phone's menu sheet, say each in full
    const blocked = online ? blockedNote(pane, t) : null;
    const blockedShort = online ? blockedLabel(pane, t) : null;
    const startedBy = parentRow ? t("Started by {name}", { name: describe(parentRow).title }) : null;
    const status = online ? activity.status(machine.id, pane) : undefined;
    const progress = online && pane.agent_progress !== undefined && (status === "working" || status === "blocked") ? t("Progress {percent}%", { percent: pane.agent_progress }) : null;
    const tooltip = [...new Set([pane.pane_id, title, context, startedBy, blocked, progress, ...tokens, markKind, name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
    const pinKey = sidebarPinKey(machine.id, pane.pane_id);
    const menuOpen = menu?.key === pinKey;
    // one menu for the ⋯ and a right-click, which opens it at the pointer and leaves the focus where it was
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void =>
      setMenu(menuOpen ? null : { key: pinKey, anchor, point, previousFocus });
    return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}${filterContext ? " is-filter-context" : ""}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id} data-pin-key={pinKey} data-depth={depth > 0 ? depth : undefined} data-more={line?.more ? "" : undefined} data-through={line?.through ? "" : undefined}
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
        {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
        <AgentRowBody mark={mark} markKind={markKind} title={title} name={name} context={context} tokens={tokens} backgroundTasks={online ? pane.background_tasks : 0} plan={online ? pane.plan : undefined} status={status} note={filterContext && selected ? t("Selected") : null} muted={muted?.includes(paneMuteKey(machine.id, pane.pane_id)) === true} blockedNote={blocked} blockedLabel={blockedShort} progress={online ? pane.agent_progress : undefined} helper={depth > 0} />
      </button>
      <div className="agent-actions">
        <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
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
  const menuShown = menuRow === undefined ? null : describe(menuRow);
  // a phone has no tooltip: its sheet says a blocked agent's whole reason, as the row's tooltip does
  const menuBlocked = menuRow !== undefined && menuShown?.online && activity.status(menuRow.machine.id, menuRow.entry.pane) === "blocked" ? blockedNote(menuRow.entry.pane, t) : null;
  const menuMuted = menuRow !== undefined && muted !== null && muted.includes(paneMuteKey(menuRow.machine.id, menuRow.entry.pane.pane_id));
  const runPin = (state: PinMenu): void => {
    // where the menu hands the focus back (lib RowMenu): the ⋯ itself unless the right-click said otherwise
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    const control = back?.closest(`.agent-item[data-pin-key="${CSS.escape(state.key)}"]`) ? back.classList.contains("row-menu-toggle") ? "row-menu-toggle" : "agent-select" : null;
    if (control) refocusPin.current = { key: state.key, control };
    togglePin(state.key);
  };
  // Settings -> Sidebar rows -> One line: an agent row is one line too, its place dim after its title
  const oneLine = settings.sidebarRows === "one";
  return <section ref={sectionRef} className={`agents-sidebar${folded ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}${oneLine ? " is-one-line" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!folded} aria-controls={listId} onClick={() => {
      // the filter's fold lasts for the filter's time and is never kept; the reader's own is
      if (filter.active) { setFilterFold(!folded); return; }
      setCollapsed(!collapsed);
      try { window.localStorage.setItem(FOLD_KEY, collapsed ? "0" : "1"); } catch { /* private mode: this page keeps it */ }
    }}>
      {folded ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {/* the count is of the agents running, filter or not */}
      {folded && allRows.length > 0 && <span className="agent-section-count">{allRows.length}</span>}
    </button>
    <div className="agent-list-contents" id={listId} hidden={folded}>
      <p className={shownEmpty === null ? "visually-hidden" : "agent-empty"} role="status">{shownEmpty}</p>
      {rows.length > 0 && <>
        {split.pinned.length > 0 && <>
          <p className="sidebar-pinned-label" aria-hidden="true"><span><Pin />{t("Pinned")}</span></p>
          <ul className="agent-list agent-list-pinned sidebar-pinned" aria-label={t("Pinned")}>{split.pinned.map(agentItem)}</ul>
        </>}
        {split.rest.length > 0 && <ul className="agent-list">{split.rest.map(agentItem)}</ul>}
      </>}
    </div>
    {menu && menuShown && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menuShown.title} subtitle={menuShown.context} detail={[menuBlocked, ...menuShown.tokens].filter(Boolean).join(" · ") || undefined} onClose={closeMenu} items={[
      menuPinned
        ? { id: "unpin", label: t("Unpin agent"), icon: PinOff, run: () => runPin(menu) }
        : { id: "pin", label: t("Pin agent"), icon: Pin, run: () => runPin(menu) },
      // one switch for every alert channel and every browser (lib/paneMutes.ts); a watching device sees its state and cannot flip it
      ...(muted === null || menuRow === undefined ? [] : [{
        id: "mute", label: menuMuted ? t("Unmute alerts") : t("Mute alerts"), icon: menuMuted ? Bell : BellOff, checked: menuMuted, disabled: watching,
        run: () => toggleMute(menuRow.machine.id, menuRow.entry.pane.pane_id),
      }]),
    ]} />}
  </section>;
}
