/**
 * Herdr's tab row, visible for a single tab too. Left-click selects; right-click opens
 * New tab with agent / Move to workspace / Rename / Close at the pointer. The + opens a shell tab at once, as herdr's
 * own new tab does. Pane actions belong to PaneCanvas.
 * The selected tab carries an ellipsis that opens its trimmed menu: a phone keeps it in view as a
 * touch entry, a desktop with a mouse draws it when the strip is hovered or the tab has keyboard
 * focus (TabStrip.css), so the menu is never only behind a right-click. Where the canvas shows a
 * split tab's panes one at a time (SOLO_PANE_QUERY), that menu lists them first.
 * That menu also carries the open pane's actions, so a lone pane shows no ellipsis of its own.
 * A strip whose tabs do not fit scrolls sideways by touch, a trackpad or a mouse wheel.
 * Each tab carries its agent's mark, and a working one a turning ring in its dot's place.
 * On a phone (the sheets' width) the row is not drawn (`inHeader`): the header's title opens
 * `sheet`, the tabs listed with their state, agent and a Close each, and the ways to a new tab.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, Ellipsis, Folder, FolderInput, Pencil, Plus, Terminal, X } from "lucide-react";

import "./TabStrip.css";

import type { HerdrPane, HerdrTab, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { ApiError, routeMissing } from "../lib/api.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { useT } from "../lib/i18n.ts";
import type { RenameRequest } from "../lib/useRenameRequest.ts";
import { autoTabLabel, customTabLabel, tabLabel } from "../lib/tabName.ts";
import { shownTabLabels, subscribeTabLabels } from "../lib/tabLabels.ts";
import { STRIP_AT_REST, stripPlaced, stripScrolled, stripSelected, type StripScroll } from "../lib/tabStripScroll.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "../lib/paneRegion.ts";
import { CRAMPED_QUERY, SOLO_PANE_QUERY, tabRowHidden } from "../lib/paneCanvas.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { moveDestinations } from "../lib/layoutTargets.ts";
import { useAppLayout, useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { usePaneLocked } from "../lib/paneLocks.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useTabReorder } from "../lib/useTabReorder.ts";
import { indicatorGlyph, paneStatus, rollupStatus, STATUS_WORD, type KnownStatus } from "../lib/status.ts";
import { useSettings } from "../lib/settings.ts";
import { AgentMark } from "./AgentMark.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { paneDrag } from "../lib/paneDrag.ts";
import { lastViewedPane, rememberViewedPane } from "../lib/lastViewedPane.ts";

/** a strip that held the focus went (TabStrip's handoff effect): its workspace, whether the window was
 *  wide when it mounted, and when. Only that workspace's strip on the other side of the width the
 *  header takes the tabs at (a resize, not a split or a workspace change) takes it, within
 *  FOCUS_HANDOFF_MS and while nothing else has. */
let focusHandoff: { workspaceId: string; wide: boolean; at: number } | null = null;
const FOCUS_HANDOFF_MS = 500;
const HEADER_TABS_QUERY = "(min-width: 769px)";

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

export interface TabStripProps {
  snapshot: SessionSnapshot;
  workspace: WorkspaceInfo;
  selectedPane: PaneInfo;
  onSelectPane: (paneId: string) => void;
  /** the New tab dialog, where an agent is picked */
  onNewTab: () => void;
  /** a shell tab in this workspace, with no dialog; rejects with herdr's refusal */
  onNewTerminal: () => Promise<void>;
  /** a one-pane tab into a new tab of another workspace on this PC; rejects with herdr's refusal */
  onMoveToWorkspace?: (tabId: string, workspaceId: string) => Promise<void>;
  /** the open pane's actions (PaneCanvas), offered in the touch menu */
  paneActions?: (paneId: string) => RowMenuItem[];
  /** the panel the tabs control: each half of a split view has its own (lib/split.ts) */
  panelId?: string;
  /** a tab dragged out of the strip may open its pane in half of the pane area (lib/paneDrag.ts) */
  splitDrag?: boolean;
  /** the app asks this strip (shortcut, palette) to open the open tab's name field, as the menu's Rename does; `onRenameHandled` clears it */
  renameRequest?: RenameRequest | null;
  onRenameHandled?: () => void;
  /** drawn at the row's far end, outside the scrolling tabs: a split view half's close (App) */
  end?: ReactNode;
  /** a phone: the header's title lists the tabs, so no row is drawn (App) */
  inHeader?: boolean;
  /** the header's title button while it has the tab list open; `onSheetClose` closes it */
  sheet?: HTMLElement | null;
  onSheetClose?: () => void;
  /** the header's row (App, from 769px): browser tabs, each with its icon (a shell's glyph when no agent) and,
   *  unless `closable` is false (a watching device), a close */
  browserTabs?: boolean;
  closable?: boolean;
}

export function TabStrip({ snapshot, workspace, selectedPane, onSelectPane, onNewTab, onNewTerminal, onMoveToWorkspace, paneActions, panelId = PANE_TABPANEL_ID, splitDrag = false, renameRequest = null, onRenameHandled, end, inHeader = false, sheet = null, onSheetClose, browserTabs = false, closable = true }: TabStripProps) {
  const t = useT();
  const { settings } = useSettings();
  const machineId = useMachineId();
  // a tab holding a locked pinned agent (lib/paneLocks.ts) is closed from no button, key or click here
  const paneLocked = usePaneLocked(machineId);
  const pressPane = useContext(PanePressContext);
  const { closeTab, renameTab, moveTab } = useMachineApi();
  // the Herdr app's window owns this PC's tabs (lib/machineContext.tsx): no rename, no move, no other workspace
  // what the PC's herdr answers for its tabs (lib/machineContext.tsx): herdr-core never reorders them
  const { rename: renameOffered, move: moveOffered, arrange } = useAppLayout();
  const touchMenu = useMediaQuery("(pointer: coarse), (max-width: 768px)");
  // a mouse on a wide screen gets the same ellipsis, drawn while the strip is hovered or the tab
  // has keyboard focus (TabStrip.css): the tab's menu is never only behind a right-click
  const hoverMenu = useMediaQuery("(hover: hover) and (pointer: fine) and (min-width: 769px)");
  const menuButton = touchMenu || hoverMenu;
  const soloPanes = useMediaQuery(SOLO_PANE_QUERY);
  // a compact-height phone screen (a foldable's outer display, landscape or the keyboard) has no
  // height to spare: a lone tab is not drawn there, so the pane and approval cards keep their room
  const cramped = useMediaQuery(CRAMPED_QUERY);
  const strip = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<{ anchor: HTMLElement; tab: HerdrTab; point?: { x: number; y: number }; previousFocus: HTMLElement | null; touch: boolean; workspaces?: true } | null>(null);
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  // the name just sent, shown until herdr's snapshot carries it
  const [sent, setSent] = useState<{ tabId: string; label: string } | null>(null);
  const [confirm, setConfirm] = useState<{ tab: HerdrTab; title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the tab whose name field just went: its button takes the focus back in the same commit, so the next key lands on it
  const refocus = useRef<string | null>(null);
  // tabs whose close is on its way: a second press, or a held Delete, does not send another
  const closing = useRef(new Set<string>());
  // A requested close: register focus return before the native snapshot can remove its tab.
  const closed = useRef<{ tabId: string; beside: string } | null>(null);
  // what is on screen now, for a close that answers after the selection or the PC has moved on
  const latest = useRef({ machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id });
  const stripTab = (): HTMLElement | null => strip.current?.querySelector<HTMLElement>('.tab-strip-item.is-active [role="tab"]')
    ?? strip.current?.querySelector<HTMLElement>('[role="tab"]') ?? null;
  latest.current = { machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id };
  const owner = JSON.stringify([machineId, workspace.workspace_id]);
  const previousOwner = useRef(owner);
  useLayoutEffect(() => {
    if (previousOwner.current === owner) return;
    previousOwner.current = owner;
    // Native IDs can repeat on another PC. A pending dialog never changes its target PC.
    setPicker(null); setEditing(null); setConfirm(null); setSent(null); setError(null);
    refocus.current = null; closed.current = null;
  }, [owner]);
  const panes = rosterPanes(snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id), selectedPane.pane_id);
  // The snapshot order is authoritative; number identifies a tab and does not change on a move.
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
  const reorder = useTabReorder({ owner: `${machineId}:${workspace.workspace_id}`, tabs, strip, moveTab, fixed: !arrange,
    failed: (reason) => setError(t("Move failed: {reason}", { reason: said(reason) })),
    stale: () => setError(t("Tab order did not refresh. Try again.")),
    // dragged down out of the strip, a tab opens its pane in half of the pane area (lib/split.ts)
    outside: splitDrag ? {
      start: (tabId) => {
        const tab = tabs.find((entry) => entry.tab_id === tabId);
        const pane = tab ? paneFor(tab) : undefined;
        if (pane) paneDrag.start({ machineId, paneId: pane.pane_id });
      },
      move: paneDrag.move, back: paneDrag.back, drop: paneDrag.drop, cancel: paneDrag.cancel,
    } : undefined,
  });
  const firstLines = useSyncExternalStore(subscribeTabLabels, shownTabLabels, shownTabLabels);
  const placeOf = (tab: HerdrTab): number => tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1;
  // a tab herdr still names by its number shows a few words of its first message (#2019); never herdr's own label
  const autoOf = (tab: HerdrTab): string | null => settings.autoTabNames
    ? autoTabLabel(tab, panes.filter((pane) => pane.tab_id === tab.tab_id), machineId, firstLines, placeOf(tab)) : null;
  // the name herdr holds (or was just sent), which a rename compares against
  const givenName = (tab: HerdrTab): string => sent?.tabId === tab.tab_id ? sent.label : tabLabel(tab, t, placeOf(tab));
  const nameOf = (tab: HerdrTab): string => sent?.tabId === tab.tab_id ? sent.label : autoOf(tab) ?? givenName(tab);

  useEffect(() => {
    // the pane each tab was last seen on, per PC: a tab clicked again opens where it was left
    rememberViewedPane("tab", machineId, selectedPane.tab_id, selectedPane.pane_id);
  }, [machineId, selectedPane.tab_id, selectedPane.pane_id]);

  // a picker, a name field or a question whose tab left (closed in the TUI) goes with it
  useEffect(() => {
    const here = (tabId: string): boolean => tabs.some((tab) => tab.tab_id === tabId);
    if (picker && !here(picker.tab.tab_id)) setPicker(null);
    if (editing && !here(editing.tabId)) setEditing(null);
    if (confirm && !here(confirm.tab.tab_id)) setConfirm(null);
    if (sent && tabs.find((tab) => tab.tab_id === sent.tabId)?.label.trim() === sent.label) setSent(null);
  });
  // The ellipsis can disappear without crossing RowMenu's narrower sheet breakpoint.
  // Its tab remains the focus return target even after the ellipsis is removed.
  useLayoutEffect(() => {
    if (picker?.touch && (!menuButton || picker.tab.tab_id !== selectedPane.tab_id)) setPicker(null);
  }, [menuButton, selectedPane.tab_id, picker]);
  useLayoutEffect(() => {
    if (editing || !refocus.current) return;
    strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  }, [editing]);
  // once the snapshot has lost a closed tab, the focus it held goes to the tab beside it, or,
  // when the strip went with it (one pane left), where a closed row's focus goes
  useLayoutEffect(() => {
    const was = closed.current;
    if (!was || tabs.some((tab) => tab.tab_id === was.tabId)) return;
    closed.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !strip.current?.contains(active)) return;
    const beside = strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(was.beside)}"]`) ?? stripTab();
    if (beside) beside.focus(); else focusWorkspaceListToggle();
  });
  // A tab that held the focus and went (closed here, in the TUI, or picked as the one beside a
  // close while the roster still listed it) drops the focus to the page: it goes to the open tab
  const focusedTab = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const was = focusedTab.current;
    if (!was || was.isConnected) return;
    focusedTab.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const tab = stripTab();
    if (tab) tab.focus(); else focusWorkspaceListToggle();
  });
  // The strip moves between the header (from 769px) and the pane as the window is resized, and a move is
  // a new strip: the focus the old one held, on a tab or in the menu it had open, goes to the new one's
  // open tab. The two need not be one commit (the layout settles over a render or two), so the old one's
  // leaving is timed, and only a page whose focus fell to the body is handed on.
  const menuOpen = useRef(false);
  const menuClosedAt = useRef(-Infinity);
  useLayoutEffect(() => {
    if (menuOpen.current && picker === null) menuClosedAt.current = performance.now();
    menuOpen.current = picker !== null;
  }, [picker]);
  const workspaceId = workspace.workspace_id;
  useLayoutEffect(() => {
    const row = strip.current;
    const wide = window.matchMedia(HEADER_TABS_QUERY).matches;
    const handoff = focusHandoff;
    if (handoff && handoff.workspaceId === workspaceId && handoff.wide !== wide && performance.now() - handoff.at < FOCUS_HANDOFF_MS
      && (!document.activeElement || document.activeElement === document.body)) {
      focusHandoff = null;
      row?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    }
    return () => {
      const dropped = !document.activeElement || document.activeElement === document.body;
      // its menu may have closed a render before it went (a resize closes it), leaving the focus nowhere
      if (row?.contains(document.activeElement) || menuOpen.current || (dropped && performance.now() - menuClosedAt.current < FOCUS_HANDOFF_MS)) {
        focusHandoff = { workspaceId, wide, at: performance.now() };
      }
    };
  }, [workspaceId]);
  // a name herdr never showed back (renamed again elsewhere) does not stay on the tab
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(null), 8000);
    return () => window.clearTimeout(timer);
  }, [sent]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // the open tab is in view: a pane opened from the sidebar, the palette or an alert can be on a
  // tab scrolled out of a phone's strip. Only the strip scrolls, never the page around it.
  const shown = panes.length > 0;
  const scroll = useRef<StripScroll>(STRIP_AT_REST);
  const bringOpenTab = (): void => {
    const row = strip.current;
    if (!row) { scroll.current = STRIP_AT_REST; return; }
    const open = row.querySelector<HTMLElement>(".tab-strip-item.is-active");
    if (!open) return;
    const view = row.getBoundingClientRect();
    const item = open.getBoundingClientRect();
    const end = row.querySelector<HTMLElement>(".tab-strip-add")?.getBoundingClientRect().left ?? view.right;
    const before = row.scrollLeft;
    if (item.left < view.left) row.scrollLeft -= view.left - item.left;
    else if (item.right > end) row.scrollLeft += item.right - end;
    // where the browser really left it; a strip that did not have to move may hold a scroll of
    // the user's whose event is still to come, and that one is left for the event to tell
    if (row.scrollLeft !== before || scroll.current.at === null) scroll.current = stripPlaced(scroll.current, row.scrollLeft);
  };
  useLayoutEffect(() => {
    scroll.current = stripSelected(scroll.current);
  }, [selectedPane.tab_id]);
  useLayoutEffect(bringOpenTab, [selectedPane.tab_id, tabs.length, shown, menuButton]);
  // A face that arrives after that (lib/fontFaces.ts) redraws every name wider or narrower with
  // no tab added or opened, so the open tab is brought into view again for each: unless the user
  // has scrolled the strip themselves since a tab was last opened (lib/tabStripScroll.ts), and is
  // looking at other tabs. A chunk can come long after the page, with the first Korean on it.
  const faces = useFacesArrived();
  useLayoutEffect(() => {
    if (!scroll.current.moved) bringOpenTab();
  }, [faces]);
  // a mouse wheel turns vertically: over a strip whose tabs do not fit it moves them sideways.
  // Anything with sideways motion (a trackpad, even a mostly vertical diagonal swipe) is the
  // browser's: moved by deltaY alone, the strip would go against the swipe's sideways part (#2103).
  // React's own onWheel is passive, so the listener is the strip's own; `end` coming or going (a
  // split opened or closed) draws the strip as a new node, which needs it again.
  const tabsHidden = tabRowHidden(cramped, tabs.length, inHeader);
  // a row that goes (a phone turned narrow) takes the menu it opened with it
  useLayoutEffect(() => {
    if (tabsHidden && editing === null) setPicker(null);
  }, [tabsHidden, editing]);
  useEffect(() => {
    const row = strip.current;
    if (!row) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0 || row.scrollWidth <= row.clientWidth) return;
      event.preventDefault();
      // deltaY is in pixels, lines (Firefox's mouse wheel) or pages, as deltaMode says
      const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? Number.parseFloat(getComputedStyle(row).fontSize) * 1.5 || 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? row.clientWidth : 1;
      row.scrollLeft += event.deltaY * step;
    };
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, [shown, tabsHidden, end === undefined]);
  const onScroll = (): void => {
    const row = strip.current;
    if (row) scroll.current = stripScrolled(scroll.current, row.scrollLeft, row.scrollWidth - row.clientWidth);
  };

  const beginRename = (tab: HerdrTab): void => {
    setError(null);
    setEditing({ tabId: tab.tab_id, value: sent?.tabId === tab.tab_id ? sent.label : customTabLabel(tab, tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1) ?? "" });
  };
  // The request is one-shot (the app clears it once handled), so the effect depends on it alone: a
  // strip that is not drawn drops it, and a later selection of this pane never replays it.
  useLayoutEffect(() => {
    if (renameRequest === null) return;
    const tab = tabs.find((candidate) => candidate.tab_id === selectedPane.tab_id);
    // a second press while the field is open keeps what was typed in it
    if (tab && shown && !tabsHidden && editing?.tabId !== tab.tab_id && renameOffered) beginRename(tab);
    onRenameHandled?.();
  }, [renameRequest]);

  // a name being typed keeps its row: a keyboard that shortens the screen past the cutoff leaves the field in place
  if (!shown) return null;
  const rowShown = !tabsHidden || editing !== null;

  const panesOf = (tab: HerdrTab): PaneInfo[] => panes.filter((pane) => pane.tab_id === tab.tab_id);
  const paneFor = (tab: HerdrTab): PaneInfo | undefined => {
    const own = panesOf(tab);
    const pick = (id: string | null | undefined) => (id ? own.find((pane) => pane.pane_id === id) : undefined);
    return pick(lastViewedPane("tab", machineId, tab.tab_id))
      ?? pick(snapshot.layouts?.find((layout) => layout.tab_id === tab.tab_id)?.focused_pane_id)
      ?? own.find((pane) => pane.focused)
      ?? own[0];
  };

  // the mark of the pane the tab opens on, else of the first agent in it
  const agentOf = (tab: HerdrTab): PaneInfo["agent"] => paneFor(tab)?.agent ?? panesOf(tab).find((pane) => pane.agent)?.agent ?? null;
  const statusOf = (tab: HerdrTab): KnownStatus => rollupStatus(panesOf(tab).map((pane) => paneStatus(pane as HerdrPane)));
  // the strip draws a mark only for a state; the sheet's list keeps a hollow one for a tab at rest, so its names line up
  const statusMark = (status: KnownStatus): ReactNode => settings.statusIndicators === "classic"
    ? <span className="tab-strip-dot" data-status={status} aria-hidden="true" />
    : <span className="tab-strip-dot tab-strip-glyph" data-status={status} aria-hidden="true">{indicatorGlyph(status, settings.statusIndicators)}</span>;
  const busyStatus = (status: KnownStatus): boolean => status === "working" || status === "blocked" || status === "waiting" || status === "done";
  const newTerminal = (): void => {
    setError(null);
    void onNewTerminal().catch((reason: unknown) => setError(t("New terminal failed: {reason}", { reason: said(reason) })));
  };

  const focusTab = (tabId: string): void => {
    window.requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(tabId)}"]`)?.focus());
  };

  // an empty name is not sent: herdr would keep it, and its own tab row would show nothing
  const saveRename = (tab: HerdrTab): void => {
    const label = editing?.value.trim() ?? "";
    if (label === "") { setError(t("A tab needs a name.")); return; }
    refocus.current = tab.tab_id;
    setEditing(null);
    if (label === givenName(tab)) return;
    setSent({ tabId: tab.tab_id, label });
    void renameTab(tab.tab_id, label).catch((reason: unknown) => {
      if (latest.current.machineId !== machineId || latest.current.workspaceId !== workspace.workspace_id) return;
      setSent((current) => current?.tabId === tab.tab_id ? null : current);
      setError(t("Rename failed: {reason}", { reason: said(reason) }));
    });
  };

  // the tab beside a closed one takes its place: the open pane moves there, and the focus with it
  const close = async (tab: HerdrTab): Promise<void> => {
    const index = tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id);
    const beside = tabs[index + 1] ?? tabs[index - 1];
    const key = JSON.stringify([machineId, workspace.workspace_id, tab.tab_id]);
    if (closing.current.has(key)) return;
    closing.current.add(key);
    // Herdr can publish the removal before the HTTP acknowledgement arrives. The removal
    // commit must already know where the disappearing tab's keyboard focus belongs.
    const focusAfterClose = beside ? { tabId: tab.tab_id, beside: beside.tab_id } : null;
    if (focusAfterClose) closed.current = focusAfterClose;
    try { await closeTab(tab.tab_id); }
    catch (reason) {
      if (closed.current === focusAfterClose) closed.current = null;
      throw reason;
    } finally { closing.current.delete(key); }
    // the answer may come after another tab, workspace or PC was picked: the open pane, and the focus, then stay
    if (latest.current.machineId !== machineId || latest.current.workspaceId !== workspace.workspace_id) return;
    // the last tab took its workspace, and the strip, with it: focus goes where a closed row's goes
    if (!beside) { focusWorkspaceListToggle(); return; }
    const pane = paneFor(beside);
    if (latest.current.tabId === tab.tab_id && pane) onSelectPane(pane.pane_id);
    if (strip.current?.contains(document.activeElement) || document.activeElement === document.body) focusTab(beside.tab_id);
  };
  // every pane of the tab by id, the ones the strip leaves out of its list (a DAG viewer's) included
  const tabLocked = (tab: HerdrTab): boolean => snapshot.panes.some((pane) => pane.tab_id === tab.tab_id && paneLocked(pane.pane_id));
  // a lock that lands while the confirmation is open (from another browser) takes the confirmation with it
  if (confirm && tabLocked(confirm.tab)) setConfirm(null);
  const requestClose = (tab: HerdrTab): void => {
    if (tabLocked(tab)) return;
    setError(null);
    // a turn that waits on its background work would lose that work too
    const busy = panesOf(tab).some((pane) => { const status = paneStatus(pane as HerdrPane); return status === "working" || status === "blocked" || status === "waiting"; });
    if (tabs.length > 1 && !busy) {
      void close(tab).catch((reason: unknown) => setError(t("Close failed: {reason}", { reason: said(reason) })));
      return;
    }
    setConfirm({
      tab,
      title: t("Close tab {name}?", { name: nameOf(tab) }),
      body: tabs.length > 1
        ? t("An agent in it is still at work, and stops with the tab.")
        : t("It is the last tab of {workspace}: the workspace closes with it, and the agents and shells in it stop.", { workspace: workspace.label }),
    });
  };

  // arrows move between the tabs; Enter or Space on one opens it, as any button; F2 names it, Delete closes it
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault(); event.stopPropagation();
      const tabId = buttons[index]?.dataset["tabId"];
      if (tabId && !event.repeat) reorder.moveAdjacent(tabId, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const anchor = buttons[index]!;
      const tab = tabs.find((candidate) => candidate.tab_id === anchor.dataset["tabId"]);
      if (tab && !event.repeat) setPicker({ anchor, tab, previousFocus: anchor, touch: false });
      return;
    }
    if (event.key === "F2" && !renameOffered) return;
    if (event.key === "F2" || event.key === "Delete") {
      // a held key is one press: the focus moves to the tab beside a closed one
      if (event.repeat) { event.preventDefault(); return; }
      const tab = tabs.find((candidate) => candidate.tab_id === buttons[index]?.dataset["tabId"]);
      if (!tab) return;
      event.preventDefault();
      if (event.key === "F2") beginRename(tab); else requestClose(tab);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const openPicker = (event: MouseEvent<HTMLElement>, tab: HerdrTab): void => {
    reorder.cancelDrag();
    const touch = event.type !== "contextmenu";
    const tabButton = event.currentTarget.parentElement?.querySelector<HTMLElement>('[role="tab"]') ?? null;
    setPicker(touch && picker?.tab.tab_id === tab.tab_id ? null : { anchor: event.currentTarget, tab,
      point: !touch && (event.clientX !== 0 || event.clientY !== 0) ? { x: event.clientX, y: event.clientY } : undefined,
      previousFocus: touch ? tabButton : document.activeElement instanceof HTMLElement ? document.activeElement : null, touch });
  };

  // Native tab menu: pane actions live on the pane itself. A split tab drawn one pane at a time
  // has no other way to its panes, so they lead its menu, the open one marked.
  // The touch menu also holds the open pane's actions, between its panes and the tab's own,
  // A one-pane-at-a-time canvas omits split and zoom, but must keep unzoom to free the other panes.
  const pickerItems = (tab: HerdrTab, touch: boolean): RowMenuItem[] => {
    const own = soloPanes ? panesOf(tab) : [];
    const layout = snapshot.layouts?.find((entry) => entry.tab_id === tab.tab_id);
    const paneItems = touch && tab.tab_id === selectedPane.tab_id
      ? (paneActions?.(selectedPane.pane_id) ?? []).filter((item) => !soloPanes
        || (item.id === "zoom" ? layout?.zoomed : item.id !== "split-right" && item.id !== "split-down")) : [];
    const groups: RowMenuItem[][] = [
      own.length < 2 ? [] : own.map((pane): RowMenuItem => ({
        id: `pane:${pane.pane_id}`, label: displayPaneTitle(pane), icon: Terminal,
        glyph: pane.agent ? <AgentMark agent={pane.agent} size={16} /> : undefined,
        current: pane.pane_id === selectedPane.pane_id, run: () => onSelectPane(pane.pane_id),
      })),
      paneItems,
      tabActions(tab),
    ].filter((group) => group.length > 0);
    return groups.flatMap((group, at) => at === 0 ? group : group.map((item, index) => index === 0 ? { ...item, divider: true } : item));
  };
  // herdr moves a tab to another workspace only as its one pane: a split tab is not offered it
  const destinations = (tab: HerdrTab) => moveDestinations(snapshot.workspaces, snapshot.panes.find((pane) => pane.tab_id === tab.tab_id), workspace.workspace_id);
  const canMoveOut = (tab: HerdrTab): boolean => onMoveToWorkspace !== undefined && moveOffered && panesOf(tab).length === 1 && destinations(tab).length > 0;
  const moveToWorkspace = (tab: HerdrTab, workspaceId: string): void => {
    setError(null);
    void onMoveToWorkspace?.(tab.tab_id, workspaceId).catch((reason: unknown) => setError(routeMissing(reason) ? t("This PC's bridge does not offer this yet") : t("Move failed: {reason}", { reason: said(reason) })));
  };
  // the same menu, in place, lists where the tab can go
  const workspaceItems = (tab: HerdrTab): RowMenuItem[] => destinations(tab).map((entry) => ({
    id: `workspace:${entry.workspace_id}`, label: entry.label, icon: Folder, run: () => moveToWorkspace(tab, entry.workspace_id),
  }));
  // the strip's + opens a shell tab; the menu keeps the dialog, where an agent is picked
  const tabActions = (tab: HerdrTab): RowMenuItem[] => [
    ...(arrange && !reorder.moving && tabs.findIndex((entry) => entry.tab_id === tab.tab_id) > 0
      ? [{ id: "move-left", label: t("Move tab left"), icon: ArrowLeft, run: () => reorder.moveAdjacent(tab.tab_id, -1) }] : []),
    ...(arrange && !reorder.moving && tabs.findIndex((entry) => entry.tab_id === tab.tab_id) < tabs.length - 1
      ? [{ id: "move-right", label: t("Move tab right"), icon: ArrowRight, run: () => reorder.moveAdjacent(tab.tab_id, 1) }] : []),
    ...(canMoveOut(tab) ? [{ id: "move-workspace", label: t("Move to workspace…"), icon: FolderInput,
      // RowMenu closes before it runs an item: the picker is set again, not updated
      run: () => { if (picker) setPicker({ ...picker, workspaces: true }); } }] : []),
    { id: "new-agent-tab", label: t("New tab with agent…"), icon: Bot, run: onNewTab },
    ...(!renameOffered ? [] : [{ id: "rename-tab", label: t("Rename tab"), icon: Pencil, run: () => beginRename(tab) }]),
    ...(tabLocked(tab) ? [] : [{ id: "close-tab", label: t("Close tab"), icon: X, danger: true, run: () => requestClose(tab) }]),
  ];

  // the pane region every tab governs, as App names it. App gives that region the tabpanel role
  // only while the pane's own tab is in this snapshot (paneTabPanelLabel); the same call answers
  // here, so a tab never claims to control a panel that is not standing there as one.
  const panePanel = paneTabPanelLabel(snapshot, selectedPane, t) !== null ? panelId : undefined;
  const row = (
      <div ref={strip} className="tab-strip" role="tablist" aria-label={t("Tabs of {workspace}", { workspace: workspace.label })} aria-busy={reorder.moving} onKeyDown={onKeyDown} onScroll={onScroll}
        onFocus={(event) => { if (event.target.getAttribute("role") === "tab") focusedTab.current = event.target; }}
        onBlur={(event) => { if (event.relatedTarget !== null) focusedTab.current = null; }}>
        {tabs.map((tab, index) => {
          const active = tab.tab_id === selectedPane.tab_id;
          const own = panesOf(tab);
          // Settle each pane's wait before rolling up, so a sibling's RUN or DONE stays visible.
          const status = statusOf(tab);
          const agent = agentOf(tab);
          const pickerOpen = picker?.tab.tab_id === tab.tab_id;
          const name = nameOf(tab);
          return (
            <div className={`tab-strip-item${active ? " is-active" : ""}${own.length > 1 ? " has-panes" : ""}${editing?.tabId === tab.tab_id ? " is-editing" : ""}${reorder.drag?.tabId === tab.tab_id ? " is-dragging" : ""}${reorder.drag?.boundary === index ? " is-drop-before" : ""}${reorder.drag?.boundary === tabs.length && index === tabs.length - 1 ? " is-drop-after" : ""}`} key={tab.tab_id}>
              {editing?.tabId === tab.tab_id ? (
                <input
                  className="input tab-strip-rename"
                  aria-label={t("Tab name")}
                  autoFocus
                  size={Math.max(8, editing.value.length + 1)}
                  maxLength={MAX_LABEL_CHARS}
                  placeholder={name}
                  value={editing.value}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditing({ tabId: tab.tab_id, value: event.target.value })}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    // an IME's Enter and Escape are the composition's, not the field's
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === "Enter") saveRename(tab);
                    if (event.key === "Escape") { refocus.current = tab.tab_id; setEditing(null); }
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  className="tab-strip-tab"
                  data-tab-id={tab.tab_id}
                  aria-selected={active}
                  aria-haspopup="menu"
                  aria-keyshortcuts={!arrange ? "Shift+F10" : "Shift+F10 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"}
                  aria-controls={panePanel}
                  tabIndex={active ? 0 : -1}
                  title={own.length === 1 && own[0] ? displayPaneTitle(own[0]) : t("{n} panes", { n: own.length })}
                  onPointerDown={(event) => {
                    reorder.onPointerDown(event, tab.tab_id);
                    // the chat of the tab pressed starts reading before the click picks it
                    const pane = event.button === 0 && !event.ctrlKey && !active ? paneFor(tab) : undefined;
                    if (pane?.agent != null) pressPane?.(machineId, pane.pane_id);
                  }}
                  onPointerMove={reorder.onPointerMove}
                  onPointerUp={reorder.onPointerUp}
                  onPointerCancel={reorder.cancelDrag}
                  onLostPointerCapture={reorder.cancelDrag}
                  onDragStart={(event) => event.preventDefault()}
                  onMouseDown={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
                  onClick={(event) => {
                    if (reorder.consumeClick(event.detail) || event.ctrlKey) return;
                    event.currentTarget.focus({ preventScroll: true });
                    const pane = paneFor(tab);
                    if (pane && pane.pane_id !== selectedPane.pane_id) onSelectPane(pane.pane_id);
                  }}
                  onDoubleClick={!renameOffered ? undefined : () => beginRename(tab)}
                  onContextMenu={(event) => { event.preventDefault(); openPicker(event, tab); }}
                  // the middle button closes a tab, as it does a browser's
                  onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); requestClose(tab); } }}
                >
                  {busyStatus(status) && statusMark(status)}
                  {/* named by the tab's own words alone: a screen reader hears the tab, not the agent's logo */}
                  {agent ? <span className="tab-strip-agent" aria-hidden="true"><AgentMark agent={agent} size={14} /></span>
                    : browserTabs && <span className="tab-strip-agent is-shell" aria-hidden="true"><Terminal /></span>}
                  <span className="tab-strip-label">{name}</span>
                </button>
              )}
              {menuButton && active && editing?.tabId !== tab.tab_id && <button type="button" className="tab-strip-menu" aria-label={t("Actions for {tab}", { tab: name })} title={t("Actions for {tab}", { tab: name })} aria-haspopup="menu" aria-expanded={pickerOpen} onClick={(event) => openPicker(event, tab)}>
                <Ellipsis aria-hidden="true" />
              </button>}
              {browserTabs && closable && editing?.tabId !== tab.tab_id && !tabLocked(tab) && <button type="button" className="tab-strip-close" tabIndex={-1} aria-label={t("Close {tab}", { tab: name })} title={t("Close {tab}", { tab: name })} onClick={() => requestClose(tab)}>
                <X aria-hidden="true" />
              </button>}
            </div>
          );
        })}
        <button type="button" className="tab-strip-add" aria-label={t("New terminal")} title={t("New terminal")} onClick={newTerminal}>
          <Plus aria-hidden="true" />
        </button>
        {error && <span className="tab-strip-error" role="alert">{error}</span>}
      </div>
  );
  // the header's list of the tabs: each opens where it was left, and closes as the row's menu closes it.
  // The open tab's moves come under them, as the row's menu has them; its other actions are in More (App)
  const openTab = tabs.find((tab) => tab.tab_id === selectedPane.tab_id);
  const sheetItems = (): RowMenuItem[] => [
    ...tabs.map((tab): RowMenuItem => {
      const status = statusOf(tab);
      const agent = agentOf(tab);
      const name = nameOf(tab);
      return {
        id: `tab:${tab.tab_id}`, label: name, icon: Terminal,
        glyph: <span className="tab-sheet-marks" aria-hidden="true">{statusMark(status)}{agent ? <AgentMark agent={agent} size={18} /> : <Terminal aria-hidden="true" />}</span>,
        ...(busyStatus(status) ? { hint: t(STATUS_WORD[status]) } : {}),
        current: tab.tab_id === selectedPane.tab_id,
        run: () => {
          const pane = paneFor(tab);
          if (pane && pane.pane_id !== selectedPane.pane_id) onSelectPane(pane.pane_id);
        },
        ...(tabLocked(tab) ? {} : { aside: { label: t("Close {tab}", { tab: name }), icon: X, run: () => requestClose(tab) } }),
      };
    }),
    ...(openTab ? tabActions(openTab).filter((item) => item.id === "move-left" || item.id === "move-right") : [])
      .map((item, index) => index === 0 ? { ...item, divider: true } : item),
    { id: "new-terminal", label: t("New terminal"), icon: Plus, divider: true, run: newTerminal },
    { id: "new-agent-tab", label: t("New tab with agent…"), icon: Bot, run: onNewTab },
  ];
  return (
    <>
      {!rowShown ? (error && <p className="pane-notice" role="alert">{error}</p>)
        : end === undefined ? row : <div className="tab-strip-row">{row}<div className="tab-strip-end">{end}</div></div>}
      {picker && <RowMenu key={picker.workspaces ? "workspaces" : "tab"} anchor={picker.anchor} point={picker.point} restoreFocusTo={picker.previousFocus}
        title={picker.workspaces ? t("Move {tab} to", { tab: nameOf(picker.tab) }) : nameOf(picker.tab)}
        items={picker.workspaces ? workspaceItems(picker.tab) : pickerItems(picker.tab, picker.touch)} align="start" onClose={() => setPicker(null)} />}
      {sheet && onSheetClose && <RowMenu anchor={sheet} title={t("Tabs of {workspace}", { workspace: workspace.label })} items={sheetItems()} onClose={onSheetClose} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close tab")} onConfirm={async () => { await close(confirm.tab); setConfirm(null); }} onClose={() => setConfirm(null)} />}
    </>
  );
}
