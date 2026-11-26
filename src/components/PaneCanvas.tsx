import { tally, usageCounters } from "../lib/usageCounters.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent, type MutableRefObject, type PointerEvent, type ReactNode } from "react";
import { ArchiveRestore, Bot, Columns2, Ellipsis, Eraser, Folder, FolderInput, LockOpen, Maximize2, Minimize2, MoveHorizontal, Pencil, Plus, Rows2, ArrowLeftRight, Terminal, TextSearch, TextWrap, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { HerdrPane, HerdrTab, PaneLayoutSnapshot, SessionSnapshot } from "../../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { customTabLabel, tabLabel } from "../lib/tabName.ts";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { moveDestinations } from "../lib/layoutTargets.ts";
import { useAppLayout, useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { PANE_DRAG_TYPE, paneDragData, type SplitSide } from "../lib/split.ts";
import { PaneSubmitRetention } from "../lib/paneSubmitRetention.ts";
import { keepPressedButtonClick } from "../lib/pressedButton.ts";
import { PaneCachedContext, PanePresentedContext, PaneShownContext, PaneSubmitContext, PaneWatchedContext } from "../lib/paneSubmitContext.ts";
import { cachedPaneCells, orderedPaneCells, visitPaneTab } from "../lib/paneTabCache.ts";
import { routeMissing } from "../lib/api.ts";
import { layoutCells, zoomMode } from "../lib/layoutMap.ts";
import { CRAMPED_QUERY, layoutTopology, paneContextPress, paneFieldTarget, paneInput, SOLO_PANE_QUERY, soloPane, splitPath, splitRatioAt, tabRowHidden } from "../lib/paneCanvas.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { MIRROR_WRAP_QUERY, wideGridKey, wideGrids } from "../lib/terminalFold.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import type { RenameRequest } from "../lib/useRenameRequest.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { usePaneLocked } from "../lib/paneLocks.ts";
import { sidebarPinKey } from "../lib/sidebarPins.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import "./PaneCanvas.css";

type PaneLayoutSplit = PaneLayoutSnapshot["splits"][number];
export type PaneActions = (target: HerdrPane, options?: { readonly counted?: boolean; readonly includeTabRow?: boolean }) => RowMenuItem[];

interface Props {
  snapshot: SessionSnapshot | null;
  pane: HerdrPane | null;
  selectedPaneId: string | null;
  onSelect: (paneId: string, focusInput?: boolean) => void;
  onChanged: () => void;
  renderPane: (pane: HerdrPane | null, active: boolean, split: boolean) => ReactNode;
  actionsRef?: MutableRefObject<PaneActions | null>;
  onOpenInHalf?: (paneId: string, side: SplitSide) => void;
  mirrored?: boolean;
  onRecoverUnsent?: (target: HerdrPane) => void;
  onSearchConversation?: (target: HerdrPane) => (() => void) | null;
  onNewTab?: () => void;
  onNewTerminal?: () => Promise<void>;
  onMoveToWorkspace?: (tabId: string, workspaceId: string) => Promise<void>;
  renameRequest?: RenameRequest | null;
  closeTabRequest?: RenameRequest | null;
  tabsInHeader?: boolean;
  /** a watching device sends no settings: it sees a locked pane's Unlock and cannot use it, as in the Agents list */
  watching?: boolean;
  solo?: boolean;
}
type Menu = { paneId: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus: HTMLElement | null };
interface Drag {
  split: PaneLayoutSplit;
  layout: PaneLayoutSnapshot;
  path: boolean[];
  topology: string;
  box: DOMRect;
  pointerId: number;
  element: HTMLElement;
  latest: number | null;
  running: boolean;
  done: boolean;
  cancelled: boolean;
  lastSent: number;
  startX: number;
  startY: number;
  startRatio: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function PaneCanvas({ snapshot, pane, selectedPaneId, onSelect, onChanged, renderPane, actionsRef, onOpenInHalf, mirrored = false, onRecoverUnsent, onSearchConversation, onNewTab, onNewTerminal, onMoveToWorkspace, renameRequest = null, closeTabRequest = null, tabsInHeader = false, watching = false, solo = false }: Props) {
  const t = useT();
  const { settings, update: updateSettings } = useSettings();
  const narrowScreen = useMediaQuery(MIRROR_WRAP_QUERY);
  const mirrorWraps = settings.terminalMirrorWrap ?? narrowScreen;
  const wideGrid = useSyncExternalStore(wideGrids.subscribe, wideGrids.snapshot, wideGrids.snapshot);
  const machineId = useMachineId();
  // the Herdr app's window owns this PC's splits (lib/machineContext.tsx): its panes are not named, swapped, split, zoomed or resized here
  const appLayout = useAppLayout();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const coarse = useMediaQuery("(pointer: coarse)");
  const popup = useMediaQuery(SHEET_QUERY) ? "dialog" : "menu";
  const narrow = useMediaQuery(SOLO_PANE_QUERY) || solo;
  const cramped = useMediaQuery(CRAMPED_QUERY);
  const api = useMachineApi();
  const canvas = useRef<HTMLDivElement>(null);
  const [submits] = useState(() => new PaneSubmitRetention());
  const retainedIds = useSyncExternalStore(submits.subscribe, submits.snapshot, submits.snapshot);
  const lastCells = useRef(new Map<string, ReturnType<typeof layoutCells>[number]>());
  const paneOrder = useRef<readonly string[]>([]);
  const visitedTabs = useRef<readonly string[]>([]);
  useEffect(() => {
    const live = new Set(snapshot?.panes.map((item) => item.pane_id) ?? []);
    submits.reconcile(live);
    for (const id of lastCells.current.keys()) if (!live.has(id)) lastCells.current.delete(id);
  }, [snapshot, submits]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<HerdrPane | null>(null);
  const [renamingTab, setRenamingTab] = useState<HerdrTab | null>(null);
  const renameDrafts = useRef(new Map<string, string>());
  const [movingTab, setMovingTab] = useState<{ tab: HerdrTab; anchor: HTMLElement } | null>(null);
  const [closingTab, setClosingTab] = useState<HerdrTab | null>(null);
  const [closing, setClosing] = useState<HerdrPane | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  const paneLocked = usePaneLocked(machineId);
  const tabLocked = (tabId: string): boolean => snapshot?.panes.some((item) => item.tab_id === tabId && paneLocked(item.pane_id)) === true;
  if (closing && paneLocked(closing.pane_id)) setClosing(null);
  if (closingTab && tabLocked(closingTab.tab_id)) setClosingTab(null);
  const previousPane = useRef(pane);
  if (pane) previousPane.current = pane;
  const previousTab = previousPane.current?.tab_id;
  const previousLayout = snapshot?.layouts.find((item) => item.tab_id === previousTab);
  const presented = pane
    ?? snapshot?.panes.find((item) => item.pane_id === previousPane.current?.pane_id)
    ?? snapshot?.panes.find((item) => item.tab_id === previousTab && item.pane_id === previousLayout?.focused_pane_id)
    ?? snapshot?.panes.find((item) => item.tab_id === previousTab)
    ?? null;
  const layout = snapshot?.layouts.find((item) => item.tab_id === presented?.tab_id) ?? null;
  const loneRowHidden = presented !== null
    && tabRowHidden(cramped, snapshot?.tabs.filter((tab) => tab.workspace_id === presented.workspace_id).length ?? 0, tabsInHeader);
  const topology = layout ? layoutTopology(layout) : "";
  const latest = useRef({ topology, tabId: presented?.tab_id, paneId: selectedPaneId, selection: 0 });
  latest.current = { topology, tabId: presented?.tab_id, paneId: selectedPaneId,
    selection: latest.current.selection + (latest.current.paneId === selectedPaneId ? 0 : 1) };
  const alive = useRef(true);
  const drag = useRef<Drag | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const fail = (reason: unknown): void => {
    if (!alive.current) return;
    if (routeMissing(reason)) { setError({ message: t("This PC's bridge does not offer this yet"), detail: null }); return; }
    const failure = userErrorMessage(reason);
    setError({ message: t("Layout change failed: {reason}", { reason: failure.message }), detail: failure.detail });
  };
  const cancelDrag = (): void => {
    const current = drag.current;
    if (!current) return;
    current.cancelled = true;
    if (current.timer !== null) clearTimeout(current.timer);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    drag.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancelDrag(); };
  }, []);
  useEffect(() => { cancelDrag(); }, [topology]);
  useEffect(() => { setMenu(null); setRenaming(null); setRenamingTab(null); setMovingTab(null); setClosingTab(null); setClosing(null); setError(null); renameDrafts.current.clear(); }, [presented?.tab_id]);
  useLayoutEffect(() => {
    if (renameRequest === null || !loneRowHidden || !appLayout.rename || !presented) return;
    const tab = snapshot?.tabs.find((entry) => entry.tab_id === presented.tab_id);
    if (tab) setRenamingTab(tab);
  }, [renameRequest]);
  useLayoutEffect(() => {
    if (closeTabRequest === null || !loneRowHidden || tabsInHeader || !presented || watching) return;
    rowItems(presented)?.tab.find((item) => item.id === "close-tab" && !item.disabled)?.run();
  }, [closeTabRequest]);
  useEffect(() => { if (menu && !snapshot?.panes.some((item) => item.pane_id === menu.paneId)) setMenu(null); }, [snapshot, menu]);

  const run = (operation: () => Promise<unknown>): void => {
    const tabId = pane?.tab_id;
    setError(null);
    void operation().then(() => { if (alive.current) onChanged(); }).catch((reason) => {
      if (latest.current.tabId === tabId) fail(reason);
    });
  };
  const showMenu = (target: HerdrPane, anchor: HTMLElement, point?: { x: number; y: number }): void => {
    setMenu({ paneId: target.pane_id, anchor, point,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  };
  const touchPress = useRef(false);
  const pressedButton = useRef<AbortController | null>(null);
  const context = (event: MouseEvent<HTMLElement>, target: HerdrPane): void => {
    const pointer = (event.nativeEvent as Partial<globalThis.PointerEvent>).pointerType;
    // Android Chrome ends a dragged text selection with a second contextmenu typed "mouse" and no
    // press of its own: only a mouse or the keyboard pressing since the touch makes it the app's
    if (pointer === "touch" || pointer === "pen" || touchPress.current || paneFieldTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showMenu(target, event.currentTarget, { x: event.clientX || rect.left + 8, y: event.clientY || rect.top + 8 });
  };
  const split = async (target: HerdrPane, direction: "right" | "down"): Promise<void> => {
    const tabId = latest.current.tabId;
    const selection = latest.current.selection;
    const made = await api.splitPane(target.pane_id, direction, true);
    if (alive.current && latest.current.tabId === tabId && latest.current.selection === selection) onSelect(made.pane_id);
  };
  // a close herdr has not yet taken out of the roster, by workspace: until then the roster still counts
  // the pane, so a second close there (another press of a bound key) would take the workspace's last pane
  // without asking, or ask herdr for the same pane again; it waits for the roster instead
  const closingIn = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [workspace, paneId] of closingIn.current) if (!snapshot?.panes.some((item) => item.pane_id === paneId)) closingIn.current.delete(workspace);
  }, [snapshot]);
  const closePane = async (target: HerdrPane): Promise<void> => {
    closingIn.current.set(target.workspace_id, target.pane_id);
    try { await api.closePane(target.pane_id); } catch (reason) {
      if (closingIn.current.get(target.workspace_id) === target.pane_id) closingIn.current.delete(target.workspace_id);
      throw reason;
    }
  };
  const requestClose = (target: HerdrPane): void => {
    if (closingIn.current.has(target.workspace_id)) return;
    const inWorkspace = snapshot?.panes.filter((item) => item.workspace_id === target.workspace_id).length ?? 1;
    if (inWorkspace === 1 || target.agent_status === "working" || target.agent_status === "blocked") setClosing(target);
    else run(() => closePane(target));
  };
  const zoom = (target: HerdrPane): void => run(async () => {
    const tabId = latest.current.tabId;
    const selection = latest.current.selection;
    await api.zoomPane(target.pane_id, layout ? zoomMode(layout, target.pane_id) : "on");
    if (alive.current && latest.current.tabId === tabId && latest.current.selection === selection) onSelect(target.pane_id);
  });
  const target = menu ? snapshot?.panes.find((item) => item.pane_id === menu.paneId) : null;
  type MenuUse = (name: "split_by_menu" | "close_pane_by_menu") => void;
  const layoutItems = (target: HerdrPane, use: MenuUse): RowMenuItem[] => [
    // herdr-core names no pane, and swaps, zooms and resizes none (lib/machineContext.tsx `arrange`)
    ...(!appLayout.arrange ? [] : [{ id: "rename", label: t("Rename pane"), icon: Pencil, run: () => setRenaming(target) }]),
    ...(appLayout.arrange && target.label ? [{ id: "clear-name", label: t("Clear pane name"), icon: Eraser, run: () => run(() => api.renamePane(target.pane_id, "")) }] : []),
    ...(appLayout.arrange && pane && target.pane_id !== pane.pane_id ? [{ id: "swap-focused", label: t("Swap with focused pane"), icon: ArrowLeftRight,
      run: () => run(() => api.swapPaneWith(pane.pane_id, target.pane_id)) }] : []),
    ...(!appLayout.split || target.own_tab ? [] : [
      { id: "split-right", label: t("Split right"), icon: Columns2, run: () => { use("split_by_menu"); run(() => split(target, "right")); } },
      { id: "split-down", label: t("Split down"), icon: Rows2, run: () => { use("split_by_menu"); run(() => split(target, "down")); } },
    ]),
    ...(!appLayout.arrange ? [] : [{ id: "zoom", label: t(layout && zoomMode(layout, target.pane_id) === "off" ? "Unzoom pane" : "Zoom pane"), icon: Maximize2,
      run: () => zoom(target) }]),
  ];
  const rowItems = (target: HerdrPane): { panes: RowMenuItem[]; tab: RowMenuItem[] } => {
    const tab = snapshot?.tabs.find((entry) => entry.tab_id === target.tab_id);
    const own = rosterPanes(snapshot?.panes.filter((item) => item.tab_id === target.tab_id) ?? [], selectedPaneId);
    return {
      panes: own.length < 2 ? [] : own.map((item): RowMenuItem => ({
        id: `pane:${item.pane_id}`, label: displayPaneTitle(item), icon: Terminal,
        glyph: item.agent ? <AgentMark agent={item.agent} size={16} /> : undefined,
        current: item.pane_id === selectedPaneId, run: () => onSelect(item.pane_id),
      })),
      tab: [
        ...(onNewTerminal && !tabsInHeader ? [{ id: "new-terminal", label: t("New terminal"), icon: Plus, disabled: watching, run: () => {
          const tabId = latest.current.tabId;
          setError(null);
          void onNewTerminal().catch((reason: unknown) => {
            if (alive.current && latest.current.tabId === tabId) setError({ message: t("New terminal failed: {reason}", { reason: userErrorMessage(reason).message }), detail: null });
          });
        } }] : []),
        // herdr moves a tab to another workspace only as its one pane, a DAG viewer the roster hides
        // counted too; the workspaces are picked in a second menu at the header's More, which this
        // menu opened from, as the row's menu lists them in place (TabStrip)
        ...(onMoveToWorkspace && appLayout.move && tab && (snapshot?.panes.filter((item) => item.tab_id === target.tab_id).length ?? 0) === 1
          && moveDestinations(snapshot?.workspaces ?? [], target, target.workspace_id).length > 0
          ? [{ id: "move-workspace", label: t("Move to workspace…"), icon: FolderInput, disabled: watching, run: () => {
            const anchor = document.querySelector<HTMLElement>(".header-more-button") ?? canvas.current;
            if (anchor) setMovingTab({ tab, anchor });
          } }] : []),
        ...(onNewTab && !tabsInHeader ? [{ id: "new-agent-tab", label: t("New tab with agent…"), icon: Bot, disabled: watching, run: onNewTab }] : []),
        ...(!appLayout.rename || !tab ? [] : [{ id: "rename-tab", label: t("Rename tab"), icon: Pencil, disabled: watching, run: () => setRenamingTab(tab) }]),
        ...(tab && !tabLocked(tab.tab_id) ? [{ id: "close-tab", label: t("Close tab"), icon: X, danger: true, disabled: watching, run: () => setClosingTab(tab) }] : []),
      ],
    };
  };
  const itemsFor: PaneActions = (target, { counted = true, includeTabRow = false } = {}) => {
    const use: MenuUse = (name) => { if (counted) tally(() => usageCounters.paneUse(name, machineId)); };
    const tabs = snapshot?.tabs.filter((tab) => tab.workspace_id === target.workspace_id).length ?? 0;
    if (!includeTabRow && !tabRowHidden(cramped, tabs, tabsInHeader)) return paneItemsFor(target, use);
    const row = rowItems(target);
    const own = paneItemsFor(target, use).filter((item) => item.id === "zoom" ? layout?.zoomed : item.id !== "split-right" && item.id !== "split-down");
    return [row.panes, own, row.tab].filter((group) => group.length > 0)
      .flatMap((group, at) => at === 0 ? group : group.map((item, index) => index === 0 ? { ...item, divider: true } : item));
  };
  const paneItemsFor = (target: HerdrPane, use: MenuUse): RowMenuItem[] => {
    const search = onSearchConversation?.(target) ?? null;
    return [
      ...(search ? [{ id: "search-conversation", label: t("Search conversation"), icon: TextSearch, run: search }] : []),
      ...layoutItems(target, use),
      ...(mirrored || wideGrid.has(wideGridKey(machineId, target.pane_id)) ? [{ id: "mirror-width", label: t(mirrorWraps ? "Original width" : "Wrap to screen"),
        icon: mirrorWraps ? MoveHorizontal : TextWrap,
        run: () => updateSettings({ terminalMirrorWrap: !mirrorWraps }) }] : []),
      ...(onRecoverUnsent && paneLifetimes.unsent().length > 0 ? [{ id: "recover-unsent", label: t("Recover unsent text"), icon: ArchiveRestore, run: () => onRecoverUnsent(target) }] : []),
      ...(paneLocked(target.pane_id)
        ? [{ id: "unlock", label: t("Unlock agent"), icon: LockOpen, disabled: watching, run: () => {
          const key = sidebarPinKey(machineId, target.pane_id);
          updateSettings(({ lockedAgents }) => ({ lockedAgents: lockedAgents.filter((held) => held !== key) }));
        } }]
        : [{ id: "close", label: t("Close pane"), icon: X, danger: true, run: () => { use("close_pane_by_menu"); requestClose(target); } }]),
    ];
  };
  const items = target ? itemsFor(target) : [];
  const published = useRef<{ ref: MutableRefObject<PaneActions | null>; items: PaneActions } | null>(null);
  if (actionsRef) { actionsRef.current = itemsFor; published.current = { ref: actionsRef, items: itemsFor }; }
  useEffect(() => () => {
    const last = published.current;
    if (last && last.ref.current === last.items) last.ref.current = null;
  }, []);

  const flush = (current: Drag): void => {
    if (current.cancelled || current.running || current.latest === null || latest.current.topology !== current.topology) return;
    const delay = 33 - (performance.now() - current.lastSent);
    if (!current.done && delay > 0) {
      if (current.timer === null) current.timer = setTimeout(() => { current.timer = null; flush(current); }, delay);
      return;
    }
    const ratio = current.latest;
    current.latest = null; current.running = true; current.lastSent = performance.now();
    void api.setSplitRatio(current.layout.tab_id, current.path, ratio).then(() => {
      if (!current.cancelled && alive.current) onChanged();
    }).catch((reason) => { if (!current.cancelled) fail(reason); current.cancelled = true; }).finally(() => {
      current.running = false;
      if (current.cancelled) return;
      if (current.latest !== null) flush(current);
      else if (current.done && drag.current === current) drag.current = null;
    });
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>, item: PaneLayoutSplit): void => {
    const path = splitPath(item.id);
    if (event.button !== 0 || !layout || !canvas.current || path === null) return;
    event.preventDefault(); event.stopPropagation(); cancelDrag();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    drag.current = { split: item, layout, path, topology, box: canvas.current.getBoundingClientRect(),
      pointerId: event.pointerId, element, latest: null, running: false, done: false, cancelled: false, lastSent: 0, timer: null,
      startX: event.clientX, startY: event.clientY, startRatio: item.ratio };
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>, done = false): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.cancelled) return;
    event.preventDefault(); event.stopPropagation();
    const initial = splitRatioAt(current.split, current.layout, current.box, current.startX, current.startY);
    current.latest = Math.max(0.1, Math.min(0.9, current.startRatio + splitRatioAt(current.split, current.layout, current.box, event.clientX, event.clientY) - initial));
    current.done = done;
    if (done && current.element.hasPointerCapture(event.pointerId)) current.element.releasePointerCapture(event.pointerId);
    flush(current);
  };
  const cells = layout ? layoutCells(layout) : pane ? [{ paneId: pane.pane_id, left: 0, top: 0, width: 100, height: 100, focused: true }] : [];
  const closingTabPanes = closingTab ? snapshot?.panes.filter((item) => item.tab_id === closingTab.tab_id) ?? [] : [];
  const closingTabWhat = closingTabPanes.length === 1 && closingTabPanes[0] ? displayPaneTitle(closingTabPanes[0]) : t("{n} panes", { n: closingTabPanes.length });
  const alone = soloPane(layout, cells.map((cell) => cell.paneId), selectedPaneId, narrow);
  const stacked = alone !== null && !layout?.zoomed;
  const zoomable = appLayout.arrange && !narrow && cells.length > 1;
  for (const cell of cells) lastCells.current.set(cell.paneId, alone === cell.paneId || stacked
    ? { ...cell, left: 0, top: 0, width: 100, height: 100 } : cell);
  const shownIds = new Set(cells.map((cell) => cell.paneId));
  visitedTabs.current = visitPaneTab(visitedTabs.current, presented?.tab_id ?? null,
    new Set(snapshot?.panes.map((item) => item.tab_id) ?? []));
  const watchedTabs = new Set(visitedTabs.current.slice(0, narrowScreen ? 2 : 4));
  const cachedCells = cachedPaneCells(visitedTabs.current, presented?.tab_id ?? null, snapshot?.panes ?? [], lastCells.current, shownIds);
  const cachedIds = new Set(cachedCells.map((cell) => cell.paneId));
  const mounted = [...cells.map((cell) => ({ ...cell, retained: false, cached: false })),
    ...cachedCells.map((cell) => ({ ...cell, retained: retainedIds.includes(cell.paneId), cached: true })),
    ...retainedIds.flatMap((id) => {
    const cell = lastCells.current.get(id);
    return !shownIds.has(id) && !cachedIds.has(id) && cell ? [{ ...cell, retained: true, cached: false }] : [];
  })];
  // React moves a keyed frame whose rank changes, and a moved frame loses the scroll of what it scrolls:
  // a pane keeps its place, and only the frames the tab draws follow the layout's own order
  const mountedCells = orderedPaneCells(paneOrder.current, mounted, shownIds);
  paneOrder.current = mountedCells.map((cell) => cell.paneId);
  const mountedIds = new Set(mountedCells.map((cell) => cell.paneId));
  for (const id of lastCells.current.keys()) if (!mountedIds.has(id)) lastCells.current.delete(id);
  return <PaneSubmitContext.Provider value={submits}><div className={`pane-canvas${!pane && presented ? " is-pending" : ""}`} ref={canvas} aria-busy={!pane && presented ? true : undefined}>
    {cells.length === 0 && renderPane(pane, true, false)}
    {mountedCells.map((cell) => {
      const item = snapshot?.panes.find((item) => item.pane_id === cell.paneId);
      if (!item) return null;
      const offTab = cell.retained || cell.cached;
      const active = !offTab && item.pane_id === selectedPaneId;
      const hidden = offTab || (alone !== null && alone !== item.pane_id);
      const single = offTab ? cell.width === 100 && cell.height === 100 : cells.length === 1 || (alone === item.pane_id && !zoomable);
      const zoomedHere = alone === item.pane_id && layout?.zoomed === true;
      // Capture contextmenu before xterm focuses its helper textarea; the menu keeps focus on the original pane.
      return <section key={item.pane_id} data-layout-pane={item.pane_id}
        className={`pane-frame${active ? " is-current" : ""}${single ? " is-single" : ""}${hidden ? " is-hidden" : ""}`}
        aria-label={displayPaneTitle(item)} aria-current={active ? "true" : undefined} aria-hidden={hidden || undefined} inert={hidden || undefined} tabIndex={-1}
        style={!offTab && (alone === item.pane_id || stacked) ? { left: 0, top: 0, width: "100%", height: "100%" }
          : { left: `${cell.left}%`, top: `${cell.top}%`, width: `${cell.width}%`, height: `${cell.height}%` }}
        // a menu asked for from the keyboard (Shift+F10, the Menu key) comes with no pointer: the last touch is not it
        onKeyDownCapture={() => { touchPress.current = false; }}
        onPointerDownCapture={(event) => {
          touchPress.current = event.pointerType === "touch" || event.pointerType === "pen";
          if (event.button === 0 && !paneContextPress(event, apple) && !active) {
            onSelect(item.pane_id, false);
            keepPressedButtonClick(event, pressedButton);
          }
          const element = event.target instanceof Element ? event.target : null;
          const titleOrFrame = element?.closest(".pane-frame-head") || element === event.currentTarget;
          if (event.button === 0 && !paneContextPress(event, apple) && !coarse && titleOrFrame && !element?.closest("button")) {
            // Cancelling pointerdown also cancels the title's native mouse drag.
            // A click focuses below; a drag suppresses that click.
            if (onOpenInHalf && element?.closest(".pane-frame-head")) return;
            event.preventDefault();
            const frame = event.currentTarget;
            paneInput(frame)?.focus({ preventScroll: true });
          }
        }}
        onDropCapture={() => { if (!active) onSelect(item.pane_id, false); }}
        onFocusCapture={(event) => { if (!active && event.currentTarget.contains(event.target)) onSelect(item.pane_id, false); }}
        onMouseDownCapture={(event) => {
          if (paneContextPress(event, apple) && !paneFieldTarget(event.target)) { event.preventDefault(); event.stopPropagation(); }
        }}
        onMouseUpCapture={(event) => {
          if (paneContextPress(event, apple) && !paneFieldTarget(event.target)) { event.preventDefault(); event.stopPropagation(); }
        }}
        onContextMenuCapture={(event) => context(event, item)}>
        {!(single && !offTab && loneRowHidden) && <div className="pane-frame-head" draggable={onOpenInHalf !== undefined && !coarse}
          onDragStart={(event: DragEvent<HTMLDivElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId: item.pane_id }));
          }}>
          <span className="pane-frame-title" role={active && !offTab ? "heading" : undefined} aria-level={active && !offTab ? 2 : undefined}><span role="button" tabIndex={0} style={{ display: "block", lineHeight: "var(--pointer-target)", overflow: "hidden", textOverflow: "ellipsis" }} onClick={(event) => {
            if (!paneContextPress(event, apple)) paneInput(event.currentTarget.closest(".pane-frame"))?.focus({ preventScroll: true });
          }} onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            paneInput(event.currentTarget.closest(".pane-frame"))?.focus({ preventScroll: true });
          }}>{displayPaneTitle(item)}</span></span>
          <button type="button" className="icon-button pane-frame-menu" aria-label={t("Pane actions for {name}", { name: displayPaneTitle(item) })} title={t("Pane actions for {name}", { name: displayPaneTitle(item) })} aria-haspopup={popup} aria-expanded={menu?.paneId === item.pane_id}
            onClick={(event) => showMenu(item, event.currentTarget)}><Ellipsis aria-hidden="true" /></button>
          {zoomable && !offTab && <button type="button" className="icon-button pane-frame-zoom" aria-label={t(zoomedHere ? "Unzoom pane" : "Zoom pane")} title={t(zoomedHere ? "Unzoom pane" : "Zoom pane")}
            onClick={(event) => { zoom(item); if (event.detail > 0) paneInput(event.currentTarget.closest(".pane-frame"))?.focus({ preventScroll: true }); }}>{zoomedHere ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button>}
          {zoomable && !offTab && !paneLocked(item.pane_id) && <button type="button" className="icon-button pane-frame-close" aria-label={t("Close pane")} title={t("Close pane")} disabled={watching}
            // Safari focuses no button a click pressed: focused here, it is the confirmation's opener, which Cancel and Escape hand back to
            // a double click's second press may land on the neighbour that took this corner: only a first press closes
            onClick={(event) => { if (event.detail > 1) return; event.currentTarget.focus({ preventScroll: true }); tally(() => usageCounters.paneUse("close_pane_by_button", machineId)); requestClose(item); }}><X aria-hidden="true" /></button>}
        </div>}
        <div className="pane-frame-body"><PaneCachedContext.Provider value={cell.cached && !cell.retained}><PaneWatchedContext.Provider value={cell.cached && !cell.retained && watchedTabs.has(item.tab_id)}><PanePresentedContext.Provider value={!offTab}><PaneShownContext.Provider value={!hidden}>{renderPane(item, active, alone === null && cells.length > 1)}</PaneShownContext.Provider></PanePresentedContext.Provider></PaneWatchedContext.Provider></PaneCachedContext.Provider></div>
      </section>;
    })}
    {alone === null && appLayout.arrange && layout?.splits.map((item) => {
      const vertical = item.direction === "right";
      const path = splitPath(item.id);
      if (path === null) return null;
      const area = layout.area;
      const left = ((item.rect.x - area.x + (vertical ? item.rect.width * item.ratio : 0)) / Math.max(1, area.width)) * 100;
      const top = ((item.rect.y - area.y + (vertical ? 0 : item.rect.height * item.ratio)) / Math.max(1, area.height)) * 100;
      return <div key={item.id} role="separator" tabIndex={0} aria-label={t("Resize split")}
        aria-orientation={vertical ? "vertical" : "horizontal"} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(item.ratio * 100)}
        className={`pane-divider ${vertical ? "is-vertical" : "is-horizontal"}`}
        style={vertical ? { left: `${left}%`, top: `${top}%`, height: `${item.rect.height / area.height * 100}%` }
          : { left: `${left}%`, top: `${top}%`, width: `${item.rect.width / area.width * 100}%` }}
        onPointerDown={(event) => startDrag(event, item)} onPointerMove={(event) => moveDrag(event)} onPointerUp={(event) => moveDrag(event, true)}
        onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (drag.current && !drag.current.done) cancelDrag(); }}
        onKeyDown={(event) => {
          const step = event.key === (vertical ? "ArrowLeft" : "ArrowUp") ? -0.05 : event.key === (vertical ? "ArrowRight" : "ArrowDown") ? 0.05 : 0;
          if (!step) return;
          event.preventDefault(); event.stopPropagation();
          run(() => api.setSplitRatio(layout.tab_id, path, Math.max(0.1, Math.min(0.9, item.ratio + step))));
        }} />;
    })}
    {error && <div className="pane-canvas-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}<button className="icon-button" aria-label={t("Dismiss")} onClick={() => setError(null)}><X /></button></div>}
    {menu && target && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={t("Pane actions for {name}", { name: displayPaneTitle(target) })}
        header={<span className="pane-frame-menu-target">{displayPaneTitle(target)}</span>} items={items} onClose={closeMenu} />}
    {renaming && <RenameDialog title={`${t("Rename pane")} · ${displayPaneTitle(renaming)}`} field={t("Pane name")} initial={renameDrafts.current.get(`pane:${renaming.pane_id}`) ?? renaming.label ?? ""} placeholder={displayPaneTitle(renaming)} maxLength={80}
      onDraft={(value) => renameDrafts.current.set(`pane:${renaming.pane_id}`, value)}
      onClose={() => setRenaming(null)}
      onCancel={() => { renameDrafts.current.delete(`pane:${renaming.pane_id}`); setRenaming(null); }}
      onSave={async (label) => { await api.renamePane(renaming.pane_id, label); renameDrafts.current.delete(`pane:${renaming.pane_id}`); onChanged(); }} />}
    {renamingTab && <RenameDialog title={`${t("Rename tab")} · ${tabLabel(renamingTab, t, 1)}`} field={t("Tab name")} initial={renameDrafts.current.get(`tab:${renamingTab.tab_id}`) ?? customTabLabel(renamingTab, 1) ?? ""} placeholder={tabLabel(renamingTab, t, 1)} maxLength={MAX_LABEL_CHARS} required={t("A tab needs a name.")}
      onDraft={(value) => renameDrafts.current.set(`tab:${renamingTab.tab_id}`, value)}
      onClose={() => setRenamingTab(null)}
      onCancel={() => { renameDrafts.current.delete(`tab:${renamingTab.tab_id}`); setRenamingTab(null); }}
      onSave={async (label) => { await api.renameTab(renamingTab.tab_id, label); renameDrafts.current.delete(`tab:${renamingTab.tab_id}`); onChanged(); }} />}
    {movingTab && <RowMenu anchor={movingTab.anchor} title={t("Move {tab} to", { tab: tabLabel(movingTab.tab, t, 1) })} align="start" onClose={() => setMovingTab(null)}
      items={moveDestinations(snapshot?.workspaces ?? [], snapshot?.panes.find((item) => item.tab_id === movingTab.tab.tab_id), movingTab.tab.workspace_id).map((entry): RowMenuItem => ({
        id: `workspace:${entry.workspace_id}`, label: entry.label, icon: Folder, run: () => {
          const tabId = latest.current.tabId;
          setError(null);
          void onMoveToWorkspace?.(movingTab.tab.tab_id, entry.workspace_id).catch((reason: unknown) => {
            if (alive.current && latest.current.tabId === tabId) setError({ message: routeMissing(reason) ? t("This PC's bridge does not offer this yet") : t("Move failed: {reason}", { reason: userErrorMessage(reason).message }), detail: null });
          });
        },
      }))} />}
    {closingTab && <ConfirmDialog title={t("Close tab {name}?", { name: tabLabel(closingTab, t, 1) })}
      body={`${t("It is the last tab of {workspace}: the workspace closes with it, and the agents and shells in it stop.", { workspace: snapshot?.workspaces.find((entry) => entry.workspace_id === closingTab.workspace_id)?.label ?? "" })} ${closingTabWhat}`}
      confirmLabel={t("Close tab")} onClose={() => setClosingTab(null)}
      onConfirm={async () => {
        await api.closeTab(closingTab.tab_id); setClosingTab(null); onChanged();
        const active = document.activeElement;
        if (!active || active === document.body || canvas.current?.contains(active) || active.closest(".confirm-dialog")) focusWorkspaceListToggle();
      }} />}
    {closing && <ConfirmDialog title={t("Close pane {name}?", { name: displayPaneTitle(closing) })}
      body={t("The pane's running processes will stop. Closing its last pane also closes the workspace.")}
      confirmLabel={t("Close pane")} onClose={() => setClosing(null)} onConfirm={async () => { await closePane(closing); setClosing(null); onChanged(); }} />}
  </div></PaneSubmitContext.Provider>;
}

function RenameDialog({ title, field, initial, placeholder, maxLength, required, onDraft, onClose, onCancel, onSave }: { title: string; field: string; initial: string; placeholder?: string; maxLength: number; required?: string; onDraft?: (value: string) => void; onClose: () => void; onCancel?: () => void; onSave: (label: string) => Promise<void> }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: input });
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  usePhoneSheetBack(() => { if (busy) return false; onClose(); });
  useEffect(() => {
    // an IME's Escape is the composition's, not the dialog's
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopPropagation(); if (!busy) onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [busy, onClose]);
  return createPortal(<div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={surface} className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <form className="pane-rename-form" onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (required !== undefined && value.trim() === "") { setError({ message: required, detail: null }); return; }
        setBusy(true); void onSave(value.trim()).then(onClose, (reason) => { setError(userErrorMessage(reason)); setBusy(false); }); }}>
        <header className="modal-header"><h2 className="modal-title">{title}</h2></header>
        <div className="modal-body"><label className="field"><span className="field-label">{field}</span><input ref={input} className="input" value={value} placeholder={placeholder} disabled={busy} maxLength={maxLength} onFocus={(event) => event.currentTarget.select()} onChange={(event) => { setValue(event.target.value); onDraft?.(event.target.value); }} /></label>{error && <p role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>}</div>
        <footer className="modal-footer"><button type="button" className="btn" disabled={busy} onClick={onCancel ?? onClose}>{t("Cancel")}</button><button className="btn btn-primary" disabled={busy}>{t("Save")}</button></footer>
      </form>
    </div>
  </div>, document.body);
}
