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
import { cachedPaneCells, visitPaneTab } from "../lib/paneTabCache.ts";
import { routeMissing } from "../lib/api.ts";
import { layoutCells, zoomMode } from "../lib/layoutMap.ts";
import { CRAMPED_QUERY, layoutTopology, paneContextPress, paneFieldTarget, SOLO_PANE_QUERY, soloPane, splitPath, splitRatioAt, tabRowHidden } from "../lib/paneCanvas.ts";
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

interface Props {
  snapshot: SessionSnapshot | null;
  pane: HerdrPane | null;
  selectedPaneId: string | null;
  onSelect: (paneId: string, focusInput?: boolean) => void;
  onChanged: () => void;
  renderPane: (pane: HerdrPane | null, active: boolean, split: boolean) => ReactNode;
  /** filled with this canvas's pane actions on each render: a phone's tab menu offers them for the open pane (TabStrip) */
  actionsRef?: MutableRefObject<((target: HerdrPane) => RowMenuItem[]) | null>;
  /** where the split view can be drawn: a pane opened in a half of it, from its menu or by dragging its title (lib/split.ts) */
  onOpenInHalf?: (paneId: string, side: SplitSide) => void;
  /** the PC's panes are mirrored (no terminal attach there): their grid can be wider than this screen */
  mirrored?: boolean;
  /** opens Recover unsent text for the pane, offered while earlier herdrs' panes left some (UnsentText) */
  onRecoverUnsent?: (target: HerdrPane) => void;
  /** Search conversation over the pane's chat (ChatView), or null where it shows no chat to search */
  onSearchConversation?: (target: HerdrPane) => (() => void) | null;
  /** the tab row's New tab with agent… and its + (a shell tab): where a lone tab's row is left out (TabStrip's cramped), the pane's menu offers them */
  onNewTab?: () => void;
  onNewTerminal?: () => Promise<void>;
  /** the row's Move to workspace…: a one-pane tab into a new tab of another workspace on this PC; rejects with herdr's refusal */
  onMoveToWorkspace?: (tabId: string, workspaceId: string) => Promise<void>;
  /** the Rename tab shortcut or palette action for the open pane: where the row is left out, its dialog stands in for the row's field (TabStrip clears it) */
  renameRequest?: RenameRequest | null;
  /** a phone's header title lists the tabs (App): no row is drawn, and its sheet holds New terminal and New tab with agent… */
  tabsInHeader?: boolean;
  /** a watching device sends no settings: it sees a locked pane's Unlock and cannot use it, as in the Agents list */
  watching?: boolean;
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

/** The active tab, drawn from herdr's rectangles. No browser-owned layout or PTY state. */
export function PaneCanvas({ snapshot, pane, selectedPaneId, onSelect, onChanged, renderPane, actionsRef, onOpenInHalf, mirrored = false, onRecoverUnsent, onSearchConversation, onNewTab, onNewTerminal, onMoveToWorkspace, renameRequest = null, tabsInHeader = false, watching = false }: Props) {
  const t = useT();
  const { settings, update: updateSettings } = useSettings();
  const narrowScreen = useMediaQuery(MIRROR_WRAP_QUERY);
  const mirrorWraps = settings.terminalMirrorWrap ?? narrowScreen;
  // attached panes drawn here at a grid this device does not size, wider than the screen (watched, or held under the keyboard)
  const wideGrid = useSyncExternalStore(wideGrids.subscribe, wideGrids.snapshot, wideGrids.snapshot);
  const machineId = useMachineId();
  // the Herdr app's window owns this PC's splits (lib/machineContext.tsx): its panes are not named, swapped, split, zoomed or resized here
  const appLayout = useAppLayout();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const coarse = useMediaQuery("(pointer: coarse)");
  // at a phone's width the pane's menu is a bottom sheet, a dialog (RowMenu): its ellipsis says so (G-037)
  const popup = useMediaQuery(SHEET_QUERY) ? "dialog" : "menu";
  const narrow = useMediaQuery(SOLO_PANE_QUERY);
  const cramped = useMediaQuery(CRAMPED_QUERY);
  const api = useMachineApi();
  const canvas = useRef<HTMLDivElement>(null);
  const [submits] = useState(() => new PaneSubmitRetention());
  const retainedIds = useSyncExternalStore(submits.subscribe, submits.snapshot, submits.snapshot);
  const lastCells = useRef(new Map<string, ReturnType<typeof layoutCells>[number]>());
  const visitedTabs = useRef<readonly string[]>([]);
  useEffect(() => {
    const live = new Set(snapshot?.panes.map((item) => item.pane_id) ?? []);
    submits.reconcile(live);
    for (const id of lastCells.current.keys()) if (!live.has(id)) lastCells.current.delete(id);
  }, [snapshot, submits]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<HerdrPane | null>(null);
  const [renamingTab, setRenamingTab] = useState<HerdrTab | null>(null);
  // a rename dismissed before Save keeps what was typed, per target, so reopening restores it
  const renameDrafts = useRef(new Map<string, string>());
  // the row's Move to workspace… and Close tab, where a lone tab's row is left out
  const [movingTab, setMovingTab] = useState<{ tab: HerdrTab; anchor: HTMLElement } | null>(null);
  const [closingTab, setClosingTab] = useState<HerdrTab | null>(null);
  const [closing, setClosing] = useState<HerdrPane | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  // a locked pinned agent (lib/paneLocks.ts) is closed from no menu here, nor is the tab it is in
  const paneLocked = usePaneLocked(machineId);
  const tabLocked = (tabId: string): boolean => snapshot?.panes.some((item) => item.tab_id === tabId && paneLocked(item.pane_id)) === true;
  // a lock that lands while a confirmation is open (from another browser) takes the confirmation with it
  if (closing && paneLocked(closing.pane_id)) setClosing(null);
  if (closingTab && tabLocked(closingTab.tab_id)) setClosingTab(null);
  // A new pane can be selected before its snapshot arrives, and a selected pane can close
  // before App confirms its replacement. Keep the prior tab's surviving mounts (and their
  // connection-owned pending sends) through either gap, with selection/input still pending.
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
  // the open tab has no row (a phone's header lists the tabs, or a lone tab on a cramped screen): its lone pane draws no ellipsis
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
  // one press each: the request depends on itself alone, as the row's does (TabStrip)
  useLayoutEffect(() => {
    if (renameRequest === null || !loneRowHidden || !appLayout.rename || !presented) return;
    const tab = snapshot?.tabs.find((entry) => entry.tab_id === presented.tab_id);
    if (tab) setRenamingTab(tab);
  }, [renameRequest]);
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
  // a long press on a touch screen is the phone's own: select text, copy (the tab's menu has the pane's actions)
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
  const requestClose = (target: HerdrPane): void => {
    const inWorkspace = snapshot?.panes.filter((item) => item.workspace_id === target.workspace_id).length ?? 1;
    if (inWorkspace === 1 || target.agent_status === "working" || target.agent_status === "blocked") setClosing(target);
    else run(() => api.closePane(target.pane_id));
  };
  // the pane's zoom item and its title's zoom button: the mode the item names, never a toggle (lib/layoutMap.ts)
  const zoom = (target: HerdrPane): void => run(async () => {
    const tabId = latest.current.tabId;
    const selection = latest.current.selection;
    await api.zoomPane(target.pane_id, layout ? zoomMode(layout, target.pane_id) : "on");
    if (alive.current && latest.current.tabId === tabId && latest.current.selection === selection) onSelect(target.pane_id);
  });
  const target = menu ? snapshot?.panes.find((item) => item.pane_id === menu.paneId) : null;
  const layoutItems = (target: HerdrPane): RowMenuItem[] => [
    // herdr-core names no pane, and swaps, zooms and resizes none (lib/machineContext.tsx `arrange`)
    ...(!appLayout.arrange ? [] : [{ id: "rename", label: t("Rename pane"), icon: Pencil, run: () => setRenaming(target) }]),
    ...(appLayout.arrange && target.label ? [{ id: "clear-name", label: t("Clear pane name"), icon: Eraser, run: () => run(() => api.renamePane(target.pane_id, "")) }] : []),
    ...(appLayout.arrange && pane && target.pane_id !== pane.pane_id ? [{ id: "swap-focused", label: t("Swap with focused pane"), icon: ArrowLeftRight,
      run: () => run(() => api.swapPaneWith(pane.pane_id, target.pane_id)) }] : []),
    ...(!appLayout.split || target.own_tab ? [] : [
      { id: "split-right", label: t("Split right"), icon: Columns2, run: () => run(() => split(target, "right")) },
      { id: "split-down", label: t("Split down"), icon: Rows2, run: () => run(() => split(target, "down")) },
    ]),
    ...(!appLayout.arrange ? [] : [{ id: "zoom", label: t(layout && zoomMode(layout, target.pane_id) === "off" ? "Unzoom pane" : "Zoom pane"), icon: Maximize2,
      run: () => zoom(target) }]),
  ];
  // A tab with no row (a phone's header lists the tabs, a lone tab on a cramped phone: TabStrip), so
  // the pane's menu carries what the row's menu would: the tab's other panes, shown one at a time
  // there, and the way to a new tab unless the header's tab sheet has it. There the pane draws no
  // ellipsis of its own: the header's More menu offers this menu (App)
  const rowItems = (target: HerdrPane): { panes: RowMenuItem[]; tab: RowMenuItem[] } | null => {
    const tabs = snapshot?.tabs.filter((tab) => tab.workspace_id === target.workspace_id).length ?? 0;
    if (!tabRowHidden(cramped, tabs, tabsInHeader)) return null;
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
        // the row's inline name field is gone with it: the tab is named in a dialog, as a pane is
        ...(!appLayout.rename || !tab ? [] : [{ id: "rename-tab", label: t("Rename tab"), icon: Pencil, disabled: watching, run: () => setRenamingTab(tab) }]),
        // the tab's last pane closes it too, but a split tab has no other way to close as one (the row's confirmation: it is the workspace's last tab)
        ...(tab && !tabLocked(tab.tab_id) ? [{ id: "close-tab", label: t("Close tab"), icon: X, danger: true, disabled: watching, run: () => setClosingTab(tab) }] : []),
      ],
    };
  };
  const itemsFor = (target: HerdrPane): RowMenuItem[] => {
    const row = rowItems(target);
    if (!row) return paneItemsFor(target);
    // as the row's menu does, a canvas showing one pane at a time offers no split or zoom, only unzoom
    const own = paneItemsFor(target).filter((item) => item.id === "zoom" ? layout?.zoomed : item.id !== "split-right" && item.id !== "split-down");
    return [row.panes, own, row.tab].filter((group) => group.length > 0)
      .flatMap((group, at) => at === 0 ? group : group.map((item, index) => index === 0 ? { ...item, divider: true } : item));
  };
  const paneItemsFor = (target: HerdrPane): RowMenuItem[] => {
    const search = onSearchConversation?.(target) ?? null;
    return [
      // the chat's own search: a menu item, so a phone's screen gains no button for it (#2018)
      ...(search ? [{ id: "search-conversation", label: t("Search conversation"), icon: TextSearch, run: search }] : []),
      ...layoutItems(target),
      // a mirror, or a pane watched at another device's grid, wider than the screen is folded to it
      // (lib/terminalFold.ts); a full-screen program reads better at its own width, panned sideways.
      // This device's choice, for every such pane
      ...(mirrored || wideGrid.has(wideGridKey(machineId, target.pane_id)) ? [{ id: "mirror-width", label: t(mirrorWraps ? "Original width" : "Wrap to screen"),
        icon: mirrorWraps ? MoveHorizontal : TextWrap,
        run: () => updateSettings({ terminalMirrorWrap: !mirrorWraps }) }] : []),
      ...(onRecoverUnsent && paneLifetimes.unsent().length > 0 ? [{ id: "recover-unsent", label: t("Recover unsent text"), icon: ArchiveRestore, run: () => onRecoverUnsent(target) }] : []),
      // a locked pane is unlocked here in place of its Close: an agent that exited leaves the Agents list, and its Unlock with it (#2977)
      ...(paneLocked(target.pane_id)
        ? [{ id: "unlock", label: t("Unlock agent"), icon: LockOpen, disabled: watching, run: () => {
          const key = sidebarPinKey(machineId, target.pane_id);
          updateSettings(({ lockedAgents }) => ({ lockedAgents: lockedAgents.filter((held) => held !== key) }));
        } }]
        : [{ id: "close", label: t("Close pane"), icon: X, danger: true, run: () => requestClose(target) }]),
    ];
  };
  const items = target ? itemsFor(target) : [];
  const published = useRef<{ ref: MutableRefObject<((target: HerdrPane) => RowMenuItem[]) | null>; items: typeof itemsFor } | null>(null);
  if (actionsRef) { actionsRef.current = itemsFor; published.current = { ref: actionsRef, items: itemsFor }; }
  // a canvas that goes (the setup guide in its place) leaves no actions behind for the header's menu
  // or the row's; another canvas that took the ref over keeps its own
  useEffect(() => () => {
    const last = published.current;
    if (last && last.ref.current === last.items) last.ref.current = null;
  }, []);

  // One in-flight ratio at a time; retain only the newest position and always flush release.
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
  // a split tab where every pane can be drawn (not a phone's one at a time): each title offers its
  // zoom, and herdr's zoomed pane keeps its title row, with Unzoom, so the hidden panes are in sight (#2037)
  const zoomable = appLayout.arrange && !narrow && cells.length > 1;
  for (const cell of cells) lastCells.current.set(cell.paneId, alone === cell.paneId || stacked
    ? { ...cell, left: 0, top: 0, width: 100, height: 100 } : cell);
  const shownIds = new Set(cells.map((cell) => cell.paneId));
  visitedTabs.current = visitPaneTab(visitedTabs.current, presented?.tab_id ?? null,
    new Set(snapshot?.panes.map((item) => item.tab_id) ?? []));
  // every recent tab keeps its screen; a phone watches only the one before the current tab, a view
  // costing its battery, and the older ones show their last screen until the user is back
  const watchedTabs = new Set(visitedTabs.current.slice(0, narrowScreen ? 2 : 4));
  const cachedCells = cachedPaneCells(visitedTabs.current, presented?.tab_id ?? null, snapshot?.panes ?? [], lastCells.current, shownIds);
  const cachedIds = new Set(cachedCells.map((cell) => cell.paneId));
  // Every frame stays under the same keyed array, including a frame returning before its ACK.
  // Retention ends when the submit/queue settles, on disconnect, native close, or PC canvas teardown.
  const mountedCells = [...cells.map((cell) => ({ ...cell, retained: false, cached: false })),
    ...cachedCells.map((cell) => ({ ...cell, retained: retainedIds.includes(cell.paneId), cached: true })),
    ...retainedIds.flatMap((id) => {
    const cell = lastCells.current.get(id);
    return !shownIds.has(id) && !cachedIds.has(id) && cell ? [{ ...cell, retained: true, cached: false }] : [];
  })];
  const mountedIds = new Set(mountedCells.map((cell) => cell.paneId));
  for (const id of lastCells.current.keys()) if (!mountedIds.has(id)) lastCells.current.delete(id);
  // herdr's zoomed pane, whatever the web selected: the selection follows it (App). A phone has
  // no room for a split, so it shows the selected pane alone the same way and leaves herdr's
  // layout as it is; the tab's menu lists the other panes (TabStrip).
  // a phone's hidden siblings take the whole canvas too, so each keeps the grid it is shown with
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
          // A right press must not change focus before the menu's Swap with focused pane.
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
            // A title has no native focus action. Prevent its default blur and take typing
            // even when this pane was already selected but a menu/tab still held focus.
            event.preventDefault();
            const frame = event.currentTarget;
            const input = frame.querySelector<HTMLElement>(".secret-input input")
              ?? frame.querySelector<HTMLElement>(".find-bar input")
              ?? (frame.querySelector(".terminal-stack.is-chat:not(.is-peek)")
                ? frame.querySelector<HTMLElement>(".composer-text")
                : frame.querySelector<HTMLElement>(".terminal-input textarea") ?? frame.querySelector<HTMLElement>(".xterm-helper-textarea"));
            input?.focus({ preventScroll: true });
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
            // dropped on a half of the pane area, the title opens its pane there (App's drop)
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
            // a click selects this pane, so its typing goes there too, as a click on the title does;
            // a key that pressed the button (detail 0) leaves the focus on it
            onClick={(event) => { zoom(item); if (event.detail > 0) paneInput(event.currentTarget.closest(".pane-frame"))?.focus({ preventScroll: true }); }}>{zoomedHere ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button>}
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
        // the workspace went with its last tab: its focus goes where a closed row's does, unless the user has moved it meanwhile
        const active = document.activeElement;
        if (!active || active === document.body || canvas.current?.contains(active) || active.closest(".confirm-dialog")) focusWorkspaceListToggle();
      }} />}
    {closing && <ConfirmDialog title={t("Close pane {name}?", { name: displayPaneTitle(closing) })}
      body={t("The pane's running processes will stop. Closing its last pane also closes the workspace.")}
      confirmLabel={t("Close pane")} onClose={() => setClosing(null)} onConfirm={async () => { await api.closePane(closing.pane_id); setClosing(null); onChanged(); }} />}
  </div></PaneSubmitContext.Provider>;
}

/** Where a pane's typing goes: an open secret or find field, the chat's message box, else the terminal. */
function paneInput(frame: Pick<Element, "querySelector"> | null): HTMLElement | null {
  if (!frame) return null;
  return frame.querySelector<HTMLElement>(".secret-input input")
    ?? frame.querySelector<HTMLElement>(".find-bar input")
    ?? (frame.querySelector(".terminal-stack.is-chat:not(.is-peek)")
      ? frame.querySelector<HTMLElement>(".composer-text")
      : frame.querySelector<HTMLElement>(".terminal-input textarea") ?? frame.querySelector<HTMLElement>(".xterm-helper-textarea"));
}

/** A pane's or a lone tab's name; `required` is the error an empty name gets, where one is not allowed (a tab's). */
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
