/** The + opens a shell tab at once, as herdr's own new tab does. */
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, ChevronDown, Ellipsis, Folder, FolderInput, Pencil, Plus, Terminal, X } from "lucide-react";

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
import { TAB_MIN_WIDTH, tabsInRow } from "../lib/tabOverflow.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "../lib/paneRegion.ts";
import { CRAMPED_QUERY, SOLO_PANE_QUERY, tabRowHidden } from "../lib/paneCanvas.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { moveDestinations } from "../lib/layoutTargets.ts";
import { useAppLayout, useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { usePaneLocked } from "../lib/paneLocks.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { useTabReorder } from "../lib/useTabReorder.ts";
import { indicatorGlyph, paneStatus, rollupStatus, STATUS_WORD, type KnownStatus } from "../lib/status.ts";
import { useSettings } from "../lib/settings.ts";
import { AgentMark } from "./AgentMark.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { paneDrag } from "../lib/paneDrag.ts";
import { lastViewedPane, rememberViewedPane } from "../lib/lastViewedPane.ts";

let focusHandoff: { workspaceId: string; wide: boolean; at: number } | null = null;
const renameDraftStore = new Map<string, string>();
let renameHandoff: { owner: string; tabId: string; value: string; layout: string; at: number } | null = null;
const stripsShowing = new Map<string, number>();
const stripLayout = (): string => typeof window === "undefined" || !window.matchMedia ? "" : `${window.matchMedia(HEADER_TABS_QUERY).matches}|${window.matchMedia(SHEET_QUERY).matches}`;
const FOCUS_HANDOFF_MS = 500;
const HEADER_TABS_QUERY = "(min-width: 769px)";

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

export interface TabStripProps {
  snapshot: SessionSnapshot;
  workspace: WorkspaceInfo;
  selectedPane: PaneInfo;
  onSelectPane: (paneId: string) => void;
  onNewTab: () => void;
  onNewTerminal: () => Promise<void>;
  onMoveToWorkspace?: (tabId: string, workspaceId: string) => Promise<void>;
  paneActions?: (paneId: string) => RowMenuItem[];
  panelId?: string;
  splitDrag?: boolean;
  renameRequest?: RenameRequest | null;
  onRenameHandled?: () => void;
  closeRequest?: RenameRequest | null;
  onCloseHandled?: () => void;
  end?: ReactNode;
  inHeader?: boolean;
  sheet?: HTMLElement | null;
  onSheetClose?: () => void;
  /** the header's row (App, from 769px): browser tabs, each with its icon (a shell's glyph when no agent) and,
   *  unless `closable` is false (a watching device), a close */
  browserTabs?: boolean;
  closable?: boolean;
  phoneRow?: boolean;
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 8;
/** the click a lifted long press still sends is the press's, not a pick; a later one (a key, a mouse) is a pick again */
const LONG_PRESS_CLICK_MS = 600;

export function TabStrip({ snapshot, workspace, selectedPane, onSelectPane, onNewTab, onNewTerminal, onMoveToWorkspace, paneActions, panelId = PANE_TABPANEL_ID, splitDrag = false, renameRequest = null, onRenameHandled, closeRequest = null, onCloseHandled, end, inHeader = false, sheet = null, onSheetClose, browserTabs = false, closable = true, phoneRow = false }: TabStripProps) {
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
  const hoverMenu = useMediaQuery("(hover: hover) and (pointer: fine) and (min-width: 769px)");
  const menuButton = touchMenu || hoverMenu;
  const popup = useMediaQuery(SHEET_QUERY) ? "dialog" : "menu";
  const soloPanes = useMediaQuery(SOLO_PANE_QUERY);
  const cramped = useMediaQuery(CRAMPED_QUERY);
  const strip = useRef<HTMLDivElement>(null);
  const stripId = useId();
  const [picker, setPicker] = useState<{ anchor: HTMLElement; tab: HerdrTab; point?: { x: number; y: number }; previousFocus: HTMLElement | null; touch: boolean; workspaces?: true } | null>(null);
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  const [sent, setSent] = useState<{ tabId: string; label: string } | null>(null);
  const [confirm, setConfirm] = useState<{ tab: HerdrTab; title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<{ width: number; add: number; open: number } | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const refocus = useRef<string | null>(null);
  const closing = useRef(new Set<string>());
  const closed = useRef<{ tabId: string; beside: string } | null>(null);
  const latest = useRef({ machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id });
  const stripTab = (): HTMLElement | null => strip.current?.querySelector<HTMLElement>('.tab-strip-item.is-active [role="tab"]')
    ?? strip.current?.querySelector<HTMLElement>('[role="tab"]') ?? null;
  latest.current = { machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id };
  const owner = JSON.stringify([machineId, workspace.workspace_id]);
  const draftKey = (tabId: string): string => JSON.stringify([owner, tabId]);
  const renameDrafts = { current: {
    get: (tabId: string) => renameDraftStore.get(draftKey(tabId)),
    set: (tabId: string, value: string) => { renameDraftStore.set(draftKey(tabId), value); },
    delete: (tabId: string) => { renameDraftStore.delete(draftKey(tabId)); },
  } };
  const editingNow = useRef(editing);
  editingNow.current = editing;
  useLayoutEffect(() => {
    stripsShowing.set(owner, (stripsShowing.get(owner) ?? 0) + 1);
    const handoff = renameHandoff;
    renameHandoff = null;
    const mountedIn = `${stripLayout()}|${settings.phoneTabs}`;
    if (handoff && handoff.owner === owner && handoff.layout !== mountedIn && performance.now() - handoff.at < FOCUS_HANDOFF_MS
      && currentTabs.current.some((tab) => tab.tab_id === handoff.tabId)) setEditing({ tabId: handoff.tabId, value: handoff.value });
    return () => {
      const open = editingNow.current;
      if (open) renameHandoff = { owner, tabId: open.tabId, value: open.value, layout: mountedIn, at: performance.now() };
      stripsShowing.set(owner, (stripsShowing.get(owner) ?? 1) - 1);
      queueMicrotask(() => {
        if ((stripsShowing.get(owner) ?? 0) > 0) return;
        stripsShowing.delete(owner);
        for (const key of renameDraftStore.keys()) if ((JSON.parse(key) as [string, string])[0] === owner) renameDraftStore.delete(key);
      });
    };
  }, [owner]);
  const previousOwner = useRef(owner);
  const longPress = useRef<{ timer: number; x: number; y: number; owner: string; tabId: string; fired: boolean; until: number } | null>(null);
  const cancelLongPress = (): void => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  };
  useEffect(() => () => { if (longPress.current) window.clearTimeout(longPress.current.timer); }, []);
  useLayoutEffect(() => {
    if (previousOwner.current === owner) return;
    previousOwner.current = owner;
    // a press held across the change (an alert opening another PC) would open the previous PC's tab menu over this one's
    cancelLongPress();
    // Native IDs can repeat on another PC. A pending dialog never changes its target PC.
    setPicker(null); setEditing(null); setConfirm(null); setSent(null); setError(null);
    refocus.current = null; closed.current = null;
  }, [owner]);
  const panes = rosterPanes(snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id), selectedPane.pane_id);
  // The snapshot order is authoritative; number identifies a tab and does not change on a move.
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
  // a watching device moves no tab (the server refuses it read_only): the order is fixed for it as for the Herdr app's
  const reorderable = arrange && closable;
  const reorder = useTabReorder({ owner: `${machineId}:${workspace.workspace_id}`, tabs, strip, moveTab, fixed: !reorderable,
    failed: (reason) => setError(t("Move failed: {reason}", { reason: said(reason) })),
    stale: () => setError(t("Tab order did not refresh. Try again.")),
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
  const givenName = (tab: HerdrTab): string => sent?.tabId === tab.tab_id ? sent.label : tabLabel(tab, t, placeOf(tab));
  const nameOf = (tab: HerdrTab): string => sent?.tabId === tab.tab_id ? sent.label : autoOf(tab) ?? givenName(tab);

  useEffect(() => {
    rememberViewedPane("tab", machineId, selectedPane.tab_id, selectedPane.pane_id);
  }, [machineId, selectedPane.tab_id, selectedPane.pane_id]);

  useEffect(() => {
    const here = (tabId: string): boolean => tabs.some((tab) => tab.tab_id === tabId);
    if (picker && !here(picker.tab.tab_id)) setPicker(null);
    if (editing && !here(editing.tabId)) setEditing(null);
    if (confirm && !here(confirm.tab.tab_id)) setConfirm(null);
    if (sent && tabs.find((tab) => tab.tab_id === sent.tabId)?.label.trim() === sent.label) setSent(null);
  });
  useLayoutEffect(() => {
    if (picker?.touch && (!menuButton || picker.tab.tab_id !== selectedPane.tab_id)) setPicker(null);
  }, [menuButton, selectedPane.tab_id, picker]);
  useLayoutEffect(() => {
    if (editing || !refocus.current) return;
    strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  }, [editing]);
  useLayoutEffect(() => {
    const was = closed.current;
    if (!was || tabs.some((tab) => tab.tab_id === was.tabId)) return;
    closed.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !strip.current?.contains(active)) return;
    const beside = strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(was.beside)}"]`) ?? stripTab();
    if (beside) beside.focus(); else focusWorkspaceListToggle();
  });
  const focusedTab = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const was = focusedTab.current;
    if (!was || was.isConnected) return;
    focusedTab.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const tab = stripTab();
    if (tab) tab.focus(); else focusWorkspaceListToggle();
  });
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
      if (row?.contains(document.activeElement) || menuOpen.current || (dropped && performance.now() - menuClosedAt.current < FOCUS_HANDOFF_MS)) {
        focusHandoff = { workspaceId, wide, at: performance.now() };
      }
    };
  }, [workspaceId]);
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
    if (row.scrollLeft !== before || scroll.current.at === null) scroll.current = stripPlaced(scroll.current, row.scrollLeft);
  };
  useLayoutEffect(() => {
    scroll.current = stripSelected(scroll.current);
  }, [selectedPane.tab_id]);
  useLayoutEffect(bringOpenTab, [selectedPane.tab_id, tabs.length, shown, menuButton]);
  const faces = useFacesArrived();
  useLayoutEffect(() => {
    if (!scroll.current.moved) bringOpenTab();
  }, [faces]);
  // a mouse wheel turns vertically: over a strip whose tabs do not fit it moves them sideways.
  // Anything with sideways motion (a trackpad, even a mostly vertical diagonal swipe) is the
  // browser's: moved by deltaY alone, the strip would go against the swipe's sideways part (#2103).
  // React's own onWheel is passive, so the listener is the strip's own; `end` coming or going (a
  // split opened or closed) draws the strip as a new node, which needs it again.
  const tabsHidden = !phoneRow && tabRowHidden(cramped, tabs.length, inHeader);
  const currentTabs = useRef(tabs);
  currentTabs.current = tabs;
  const openLongPress = (pressed: NonNullable<typeof longPress.current>, anchor: HTMLElement, tab: HerdrTab, active: boolean): void => {
    window.clearTimeout(pressed.timer);
    if (longPress.current !== pressed || pressed.fired) return;
    if (pressed.owner !== previousOwner.current || !anchor.isConnected || !currentTabs.current.some((entry) => entry.tab_id === pressed.tabId)) { longPress.current = null; return; }
    pressed.fired = true;
    pressed.until = Infinity;
    setPicker({ anchor, tab, previousFocus: anchor, touch: active });
  };
  const liftLongPress = (): void => {
    const pressed = longPress.current;
    if (!pressed) return;
    if (pressed.fired) pressed.until = performance.now() + LONG_PRESS_CLICK_MS;
    else cancelLongPress();
  };
  useLayoutEffect(() => {
    if (tabsHidden && editing === null) setPicker(null);
  }, [tabsHidden, editing]);
  useLayoutEffect(() => {
    const row = strip.current;
    if (!browserTabs || !row) { setRoom(null); return; }
    const measure = (): void => {
      const add = row.querySelector<HTMLElement>(".tab-strip-add");
      const addWidth = add ? add.getBoundingClientRect().width + (Number.parseFloat(getComputedStyle(add).marginLeft) || 0) : 0;
      const openTab = row.querySelector<HTMLElement>(".tab-strip-item.is-active");
      const openWidth = (openTab && Number.parseFloat(getComputedStyle(openTab).minWidth)) || TAB_MIN_WIDTH;
      setRoom((was) => was?.width === row.clientWidth && was.add === addWidth && was.open === openWidth ? was : { width: row.clientWidth, add: addWidth, open: openWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [browserTabs, shown, tabsHidden]);
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
    const saved = sent?.tabId === tab.tab_id ? sent.label : customTabLabel(tab, tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1) ?? "";
    const draft = renameDrafts.current.get(tab.tab_id);
    setEditing({ tabId: tab.tab_id, value: draft !== undefined ? draft : saved });
  };
  useLayoutEffect(() => {
    if (renameRequest === null) return;
    const tab = tabs.find((candidate) => candidate.tab_id === selectedPane.tab_id);
    if (tab && shown && !tabsHidden && editing?.tabId !== tab.tab_id && renameOffered) beginRename(tab);
    onRenameHandled?.();
  }, [renameRequest]);
  useLayoutEffect(() => {
    if (closeRequest === null) return;
    const tab = tabs.find((candidate) => candidate.tab_id === selectedPane.tab_id);
    if (tab && shown && !tabsHidden && closable) requestClose(tab);
    onCloseHandled?.();
  }, [closeRequest]);

  // the More list is long (it holds every tab that does not fit): letters typed over it jump to the next tab whose
  // name starts with them, as a native menu's typeahead does (G-160). RowMenu's own type-ahead does it; a second
  // one here would move the focus twice per letter and skip a tab sharing its first letter
  if (!shown) return null;
  const rowShown = !tabsHidden || editing !== null;
  const openIndex = Math.max(0, tabs.findIndex((tab) => tab.tab_id === selectedPane.tab_id));
  const editingIndex = editing ? tabs.findIndex((tab) => tab.tab_id === editing.tabId) : -1;
  const inRow = room === null ? null : new Set(tabsInRow(tabs.length, openIndex, room.width, room.add, room.open, editingIndex));
  const leftOut = inRow === null ? [] : tabs.filter((_, index) => !inRow.has(index));
  const drawnNext = (index: number): boolean => inRow === null ? index + 1 < tabs.length : inRow.has(index + 1);
  if (moreAnchor && leftOut.length === 0) setMoreAnchor(null);

  const panesOf = (tab: HerdrTab): PaneInfo[] => panes.filter((pane) => pane.tab_id === tab.tab_id);
  const paneFor = (tab: HerdrTab): PaneInfo | undefined => {
    const own = panesOf(tab);
    const pick = (id: string | null | undefined) => (id ? own.find((pane) => pane.pane_id === id) : undefined);
    return pick(lastViewedPane("tab", machineId, tab.tab_id))
      ?? pick(snapshot.layouts?.find((layout) => layout.tab_id === tab.tab_id)?.focused_pane_id)
      ?? own.find((pane) => pane.focused)
      ?? own[0];
  };

  // where a split tab shows one pane at a time, its open tab is that pane: the chip names it and wears its mark
  const openPaneOf = (tab: HerdrTab): PaneInfo | null => soloPanes && tab.tab_id === selectedPane.tab_id && panesOf(tab).length > 1 ? selectedPane : null;
  // a name someone gave the tab is never covered
  const chipName = (tab: HerdrTab): string => {
    const open = openPaneOf(tab);
    if (!open || sent?.tabId === tab.tab_id || customTabLabel(tab, placeOf(tab)) !== null) return nameOf(tab);
    // the pane's own name first: a line learned from its terminal's first message never covers it
    return open.label?.trim() || (settings.autoTabNames ? autoTabLabel(tab, [open], machineId, firstLines, placeOf(tab)) : null) || displayPaneTitle(open);
  };
  const agentOf = (tab: HerdrTab): PaneInfo["agent"] => paneFor(tab)?.agent ?? panesOf(tab).find((pane) => pane.agent)?.agent ?? null;
  // the chip alone wears the open pane's mark: the tab sheet keeps the tab's own
  const chipAgentOf = (tab: HerdrTab): PaneInfo["agent"] => {
    const open = openPaneOf(tab);
    return open ? open.agent ?? null : agentOf(tab);
  };
  // the agent's name as herdr shows it ("OmO" for omo), for the tab's spoken description
  const agentNameOf = (tab: HerdrTab): string | null => {
    const open = openPaneOf(tab);
    if (open) return open.agent ? open.display_agent?.trim() || open.agent : null;
    const opens = paneFor(tab);
    const pane = opens?.agent ? opens : panesOf(tab).find((candidate) => candidate.agent);
    return pane?.display_agent?.trim() || pane?.agent || null;
  };
  const statusOf = (tab: HerdrTab): KnownStatus => rollupStatus(panesOf(tab).map((pane) => paneStatus(pane as HerdrPane)));
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
    renameDrafts.current.delete(tab.tab_id);
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
    if (latest.current.machineId !== machineId || latest.current.workspaceId !== workspace.workspace_id) return;
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
    const own = snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id);
    const what = own.length === 1 && own[0] ? displayPaneTitle(own[0]) : t("{n} panes", { n: own.length });
    // a turn that waits on its background work would lose that work too
    const busy = panesOf(tab).some((pane) => { const status = paneStatus(pane as HerdrPane); return status === "working" || status === "blocked" || status === "waiting"; });
    if (tabs.length > 1 && !busy) {
      void close(tab).catch((reason: unknown) => setError(t("Close failed: {reason}", { reason: said(reason) })));
      return;
    }
    setConfirm({
      tab,
      title: t("Close tab {name}?", { name: nameOf(tab) }),
      body: `${tabs.length > 1
        ? t("An agent in it is still at work, and stops with the tab.")
        : t("It is the last tab of {workspace}: the workspace closes with it, and the agents and shells in it stop.", { workspace: workspace.label })} ${what}`,
    });
  };

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

  // A one-pane-at-a-time canvas omits split and zoom, but must keep unzoom to free the other panes.
  const pickerItems = (tab: HerdrTab, touch: boolean): RowMenuItem[] => {
    const own = soloPanes ? panesOf(tab) : [];
    const layout = snapshot.layouts?.find((entry) => entry.tab_id === tab.tab_id);
    const tabItems = tabActions(tab);
    const paneList = own.length < 2 ? [] : own.map((pane): RowMenuItem => ({
      id: `pane:${pane.pane_id}`, label: displayPaneTitle(pane), icon: Terminal,
      glyph: pane.agent ? <AgentMark agent={pane.agent} size={16} /> : undefined,
      current: pane.pane_id === selectedPane.pane_id, run: () => onSelectPane(pane.pane_id),
    }));
    // the pane's actions list the tab's panes too where the tab row counts as hidden (the header's tabs): once is enough
    const listed = [...tabItems, ...paneList];
    const paneItems = touch && tab.tab_id === selectedPane.tab_id
      ? (paneActions?.(selectedPane.pane_id) ?? []).filter((item) => !listed.some((own) => own.id === item.id) && (!soloPanes
        || (item.id === "zoom" ? layout?.zoomed : item.id !== "split-right" && item.id !== "split-down"))) : [];
    const groups: RowMenuItem[][] = [
      paneList,
      paneItems,
      tabItems,
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
  const workspaceItems = (tab: HerdrTab): RowMenuItem[] => destinations(tab).map((entry) => ({
    id: `workspace:${entry.workspace_id}`, label: entry.label, icon: Folder, run: () => moveToWorkspace(tab, entry.workspace_id),
  }));
  const tabActions = (tab: HerdrTab): RowMenuItem[] => {
    const name = nameOf(tab);
    const about = (label: string): string => `${label} · ${name}`;
    return [
      ...(reorderable && !reorder.moving && tabs.findIndex((entry) => entry.tab_id === tab.tab_id) > 0
        ? [{ id: "move-left", label: t("Move tab left"), title: about(t("Move tab left")), icon: ArrowLeft, run: () => reorder.moveAdjacent(tab.tab_id, -1) }] : []),
      ...(reorderable && !reorder.moving && tabs.findIndex((entry) => entry.tab_id === tab.tab_id) < tabs.length - 1
        ? [{ id: "move-right", label: t("Move tab right"), title: about(t("Move tab right")), icon: ArrowRight, run: () => reorder.moveAdjacent(tab.tab_id, 1) }] : []),
      ...(canMoveOut(tab) ? [{ id: "move-workspace", label: t("Move to workspace…"), title: t("Move {tab} to", { tab: name }), icon: FolderInput, disabled: !closable,
        run: () => { if (picker) setPicker({ ...picker, workspaces: true }); } }] : []),
      { id: "new-agent-tab", label: t("New tab with agent…"), icon: Bot, disabled: !closable, run: onNewTab },
      ...(!renameOffered ? [] : [{ id: "rename-tab", label: t("Rename tab"), title: about(t("Rename tab")), icon: Pencil, disabled: !closable, run: () => beginRename(tab) }]),
      ...(tabLocked(tab) || !closable ? [] : [{ id: "close-tab", label: t("Close tab"), title: t("Close {tab}", { tab: name }), icon: X, danger: true, run: () => requestClose(tab) }]),
    ];
  };

  const panePanel = paneTabPanelLabel(snapshot, selectedPane, t) !== null ? panelId : undefined;
  const row = (
      <div ref={strip} className="tab-strip" role="tablist" aria-label={t("Tabs of {workspace}", { workspace: workspace.label })} aria-busy={reorder.moving} onKeyDown={onKeyDown} onScroll={onScroll}
        onFocus={(event) => { if (event.target.getAttribute("role") === "tab") focusedTab.current = event.target; }}
        onBlur={(event) => { if (event.relatedTarget !== null) focusedTab.current = null; }}>
        {tabs.map((tab, index) => {
          if (inRow !== null && !inRow.has(index)) return null;
          const active = tab.tab_id === selectedPane.tab_id;
          const own = panesOf(tab);
          const status = statusOf(tab);
          const agent = chipAgentOf(tab);
          const pickerOpen = picker?.tab.tab_id === tab.tab_id;
          const name = nameOf(tab);
          const shownName = chipName(tab);
          const tabStatusId = `${stripId}-desc-${tab.tab_id}`;
          const tabDescription = [agentNameOf(tab) ?? (browserTabs || phoneRow ? t("Shell") : null), status !== "unknown" ? t(STATUS_WORD[status]) : null].filter(Boolean).join(" · ");
          const paneTitle = own.length === 1 && own[0] ? displayPaneTitle(own[0]) : t("{n} panes", { n: own.length });
          const tabTitle = paneTitle.includes(shownName) ? paneTitle : `${shownName} — ${paneTitle}`;
          return (
            <div className={`tab-strip-item${active ? " is-active" : ""}${own.length > 1 ? " has-panes" : ""}${editing?.tabId === tab.tab_id ? " is-editing" : ""}${reorder.drag?.tabId === tab.tab_id ? " is-dragging" : ""}${reorder.drag?.boundary === index ? " is-drop-before" : ""}${reorder.drag?.boundary === index + 1 && !drawnNext(index) ? " is-drop-after" : ""}`} key={tab.tab_id} data-tab-index={index}>
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
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    renameDrafts.current.set(tab.tab_id, nextValue);
                    setEditing({ tabId: tab.tab_id, value: nextValue });
                  }}
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
                  aria-haspopup={popup}
                  aria-keyshortcuts={!reorderable ? "Shift+F10" : "Shift+F10 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"}
                  aria-controls={panePanel}
                  aria-describedby={tabDescription ? tabStatusId : undefined}
                  tabIndex={active ? 0 : -1}
                  title={tabTitle}
                  onPointerDown={(event) => {
                    cancelLongPress();
                    if (phoneRow && event.pointerType !== "mouse") {
                      const anchor = event.currentTarget;
                      const pressed = { x: event.clientX, y: event.clientY, owner, tabId: tab.tab_id, fired: false, until: Infinity, timer: 0 };
                      longPress.current = pressed;
                      pressed.timer = window.setTimeout(() => openLongPress(pressed, anchor, tab, active), LONG_PRESS_MS);
                    }
                    reorder.onPointerDown(event, tab.tab_id);
                    const pane = event.button === 0 && !event.ctrlKey && !active ? paneFor(tab) : undefined;
                    if (pane?.agent != null) pressPane?.(machineId, pane.pane_id);
                  }}
                  onPointerMove={(event) => {
                    const pressed = longPress.current;
                    if (pressed && !pressed.fired && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > LONG_PRESS_SLOP) cancelLongPress();
                    reorder.onPointerMove(event);
                  }}
                  onPointerUp={(event) => { liftLongPress(); reorder.onPointerUp(event); }}
                  // the lift of a held press sends no mouse events or click: the focus they move would close the menu it opened
                  onTouchEnd={(event) => { if (longPress.current?.fired) event.preventDefault(); }}
                  onPointerCancel={() => { liftLongPress(); reorder.cancelDrag(); }}
                  onLostPointerCapture={reorder.cancelDrag}
                  onDragStart={(event) => event.preventDefault()}
                  onMouseDown={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
                  onClick={(event) => {
                    const pressed = longPress.current;
                    if (pressed?.fired) {
                      longPress.current = null;
                      if (performance.now() <= pressed.until) return;
                    }
                    if (reorder.consumeClick(event.detail) || event.ctrlKey) return;
                    event.currentTarget.focus({ preventScroll: true });
                    // the open split tab, one pane in view: a tap lists its panes, the menu its ⋯ and a long press open
                    if (active && soloPanes && own.length > 1) {
                      const anchor = event.currentTarget;
                      setPicker(picker?.tab.tab_id === tab.tab_id ? null : { anchor, tab, previousFocus: anchor, touch: true });
                      return;
                    }
                    const pane = paneFor(tab);
                    if (pane && pane.pane_id !== selectedPane.pane_id) onSelectPane(pane.pane_id);
                  }}
                  onDoubleClick={!renameOffered || !closable ? undefined : () => beginRename(tab)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    // Android's own long-press contextmenu can come before the timer: one path opens the menu, once
                    const pressed = longPress.current;
                    if (phoneRow && pressed && pressed.tabId === tab.tab_id) { openLongPress(pressed, event.currentTarget, tab, active); return; }
                    openPicker(event, tab);
                  }}
                  // the middle button closes a tab, as it does a browser's
                  onAuxClick={(event) => { if (event.button === 1 && closable) { event.preventDefault(); requestClose(tab); } }}
                >
                  {busyStatus(status) && statusMark(status)}
                  {agent ? <span className="tab-strip-agent" aria-hidden="true"><AgentMark agent={agent} size={14} /></span>
                    : (browserTabs || phoneRow) && <span className="tab-strip-agent is-shell" aria-hidden="true"><Terminal /></span>}
                  <span className="tab-strip-label">{shownName}</span>
                  {(phoneRow || soloPanes) && active && own.length > 1 && (() => {
                    const index = own.findIndex((pane) => pane.pane_id === selectedPane.pane_id) + 1;
                    return <span className="tab-strip-position"><span aria-hidden="true">{index}/{own.length}</span><span className="visually-hidden">{", "}{t("Pane {index} of {count}", { index, count: own.length })}</span></span>;
                  })()}
                </button>
              )}
              {/* beside the tab, not in it: inside, its words would join the tab's name ("Tab 1Shell") */}
              {tabDescription && <span id={tabStatusId} className="visually-hidden">{tabDescription}</span>}
              {menuButton && active && !phoneRow && editing?.tabId !== tab.tab_id && <button type="button" className="tab-strip-menu" aria-label={t("Actions for {tab}", { tab: name })} title={t("Actions for {tab}", { tab: name })} aria-haspopup={popup} aria-expanded={pickerOpen} onClick={(event) => openPicker(event, tab)}>
                <Ellipsis aria-hidden="true" />
              </button>}
              {browserTabs && closable && editing?.tabId !== tab.tab_id && !tabLocked(tab) && <button type="button" className="tab-strip-close" tabIndex={-1} aria-label={t("Close {tab}", { tab: name })} title={t("Close {tab}", { tab: name })} onClick={() => requestClose(tab)}>
                <X aria-hidden="true" />
              </button>}
            </div>
          );
        })}
        {!phoneRow && <button type="button" className="tab-strip-add" disabled={!closable} aria-label={t("New terminal")} title={!closable ? `${t("New terminal")} · ${t("View only")}` : t("New terminal")} onClick={newTerminal}>
          <Plus aria-hidden="true" />
        </button>}
        {leftOut.length > 0 && <button type="button" className="tab-strip-more" aria-label={t("{n} more tabs", { n: leftOut.length })} title={t("{n} more tabs", { n: leftOut.length })}
          aria-haspopup={popup} aria-expanded={moreAnchor !== null} onClick={(event) => setMoreAnchor(moreAnchor ? null : event.currentTarget)}>
          <ChevronDown aria-hidden="true" />{leftOut.length}
        </button>}
        {error && popup !== "dialog" && <span className="tab-strip-error" role="alert">{error}</span>}
      </div>
  );
  const openTab = tabs.find((tab) => tab.tab_id === selectedPane.tab_id);
  // a menu left open draws the tab as it is now: a rename from elsewhere is not sent back over
  const pickedTab = picker ? tabs.find((tab) => tab.tab_id === picker.tab.tab_id) ?? picker.tab : null;
  const tabItem = (tab: HerdrTab): RowMenuItem => {
    const status = statusOf(tab);
    const agent = agentOf(tab);
    return {
      id: `tab:${tab.tab_id}`, label: nameOf(tab), icon: Terminal,
      glyph: <span className="tab-sheet-marks" aria-hidden="true">{statusMark(status)}{agent ? <AgentMark agent={agent} size={18} /> : <Terminal aria-hidden="true" />}</span>,
      ...(busyStatus(status) ? { hint: t(STATUS_WORD[status]) } : {}),
      current: tab.tab_id === selectedPane.tab_id,
      run: () => {
        const pane = paneFor(tab);
        if (pane && pane.pane_id !== selectedPane.pane_id) onSelectPane(pane.pane_id);
      },
    };
  };
  const sheetItems = (): RowMenuItem[] => [
    ...tabs.map((tab): RowMenuItem => ({
      ...tabItem(tab),
      ...(tabLocked(tab) || !closable ? {} : { aside: { label: t("Close {tab}", { tab: nameOf(tab) }), icon: X, run: () => requestClose(tab) } }),
    })),
    ...(openTab && closable ? tabActions(openTab).filter((item) => item.id === "move-left" || item.id === "move-right") : [])
      .map((item, index) => index === 0 ? { ...item, divider: true } : item),
    { id: "new-terminal", label: t("New terminal"), icon: Plus, divider: true, disabled: !closable, run: newTerminal },
    { id: "new-agent-tab", label: t("New tab with agent…"), icon: Bot, disabled: !closable, run: onNewTab },
  ];
  return (
    <>
      {!rowShown ? (error && <p className="pane-notice" role="alert">{error}</p>)
        : end === undefined ? row : <div className="tab-strip-row">{row}<div className="tab-strip-end">{end}</div></div>}
      {rowShown && error && popup === "dialog" && <p className="pane-notice tab-strip-notice" role="alert">{error}</p>}
      {picker && pickedTab && <RowMenu key={picker.workspaces ? "workspaces" : "tab"} anchor={picker.anchor} point={picker.point} restoreFocusTo={picker.previousFocus}
        title={picker.workspaces ? t("Move {tab} to", { tab: nameOf(pickedTab) }) : nameOf(pickedTab)}
        header={<span className="tab-strip-menu-target">{picker.workspaces ? t("Move {tab} to", { tab: nameOf(pickedTab) }) : nameOf(pickedTab)}</span>}
        items={picker.workspaces ? workspaceItems(pickedTab) : pickerItems(pickedTab, picker.touch)} align="start" onClose={() => setPicker(null)} />}
      {moreAnchor && leftOut.length > 0 && <RowMenu anchor={moreAnchor} restoreFocusTo={moreAnchor} title={t("More tabs")} items={leftOut.map(tabItem)} align="start" onClose={() => setMoreAnchor(null)} />}
      {sheet && onSheetClose && <RowMenu anchor={sheet} title={t("Tabs of {workspace}", { workspace: workspace.label })} items={sheetItems()} onClose={onSheetClose} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close tab")} onConfirm={async () => { await close(confirm.tab); setConfirm(null); }} onClose={() => setConfirm(null)} />}
    </>
  );
}
