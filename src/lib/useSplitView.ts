import { type Dispatch, type DragEvent, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HerdrPane, HerdrWorkspace, PaneDirection } from "../../shared/protocol.ts";
import { paneStorageId, type HerdrIdentity, type Machine } from "../../shared/machines.ts";
import { fetchSession, type HealthInfo } from "./api.ts";
import { activateSlot as activatedSlot, besideSide, MAX_SPLIT_SLOTS, closeSlots, dockPane, draggedPane, dropZone, pickInSlot, PANE_DRAG_TYPE, replaceSlotPane, resizeSplit, sameTarget, sideZone, slotRects, slotsOf, splitDividers, storedSplit, storeSplit, withoutSlots, zoneRect, type DropZone, type SplitChange, type SplitRect, type SplitSide, type SplitSlot, type SplitState, type SplitTarget } from "./split.ts";
import { paneDrag, type PaneDrag } from "./paneDrag.ts";

const SELECTION_KEY = "ovis:selection";
type StoredSelection = { machine_id?: string; pane_id?: string | null };

/**
 * The pane to open: this window's own (sessionStorage is per window and survives
 * its reloads), else the last one any window showed, for a newly opened window.
 */
export function storedSelection(): StoredSelection | null {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try {
      const value: unknown = JSON.parse(window[storage].getItem(SELECTION_KEY) ?? "null");
      if (value !== null && typeof value === "object") return value as StoredSelection;
    } catch {
      /* private mode */
    }
  }
  return null;
}

export function storeSelection(machineId: string, paneId: string | null): void {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try { window[storage].setItem(SELECTION_KEY, JSON.stringify({ machine_id: machineId, pane_id: paneId })); } catch {}
  }
}

export function useSplitRecheck() {
  // a split half whose pane the PC could not be asked about is checked again on the next roster
  const otherRecheck = useRef(false);
  const [otherRosterTick, setOtherRosterTick] = useState(0);
  return { otherRecheck, otherRosterTick, setOtherRosterTick };
}

export function useSplitState() {
  // panes side by side (lib/split.ts): the layout, every other slot's pane, and the active slot.
  // Only drawn where the sidebar stands beside the pane; a narrower window shows the active slot
  const [split, setSplitState] = useState<SplitState | null>(storedSplit);
  const setSplit = useCallback((next: SplitState | null) => {
    setSplitState(next);
    storeSplit(next);
  }, []);
  // the slot a single pane is drawn in: the half left when a split ends keeps its slot, and with it
  // its terminals' connections and the messages those connections hold for the agent
  const [soloSlot, setSoloSlot] = useState<SplitSlot>(() => storedSplit()?.active ?? "a");
  const endSplit = useCallback((remaining: SplitSlot) => {
    setSplit(null);
    setSoloSlot(remaining);
  }, [setSplit]);
  const splitRef = useRef(split); splitRef.current = split;
  // whether the other half is drawn: a narrow window keeps the split but shows the active half alone
  const splitShownRef = useRef(false);
  // when a key was last pressed: a focus moving into the other half makes it active only right after
  // one (a Tab), never when the app's own code moves the focus (an upload that finished)
  const lastKeyAtRef = useRef(0);
  useEffect(() => {
    const onKey = (): void => { lastKeyAtRef.current = Date.now(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // the guide appears as soon as a pane is picked up; a target is chosen only over the area
  const [paneDragging, setPaneDragging] = useState(false);
  // the guide shows every slot and the slot's edge or middle the pane would take
  const [gridDrop, setGridDrop] = useState<DropZone | null>(null);
  const gridDropRef = useRef<DropZone | null>(null);
  const showGridDrop = useCallback((zone: DropZone | null): void => {
    gridDropRef.current = zone;
    setGridDrop((shown) => (shown?.slot === zone?.slot && shown?.edge === zone?.edge ? shown : zone));
  }, []);
  const hideDropTarget = useCallback((): void => showGridDrop(null), [showGridDrop]);
  // the pane being dragged, read at dragstart (a dragover cannot read the drag's data), the title it
  // would trade places with if dropped now, and the pane it would go beside, its frame showing the
  // side (PaneCanvas.css). Only a drag from the pane's own title arranges its tab: a sidebar row, a
  // tab or a half's bar dropped there still opens a half
  const draggedPaneRef = useRef<SplitTarget | null>(null);
  const swapHeadRef = useRef<HTMLElement | null>(null);
  const markSwap = useCallback((head: HTMLElement | null): void => {
    if (swapHeadRef.current === head) return;
    swapHeadRef.current?.classList.remove("is-swap-target");
    head?.classList.add("is-swap-target");
    swapHeadRef.current = head;
  }, []);
  const moveFrameRef = useRef<HTMLElement | null>(null);
  const markMove = useCallback((frame: HTMLElement | null, side: PaneDirection | null = null): void => {
    if (moveFrameRef.current !== frame) moveFrameRef.current?.removeAttribute("data-move-side");
    if (frame && side) frame.setAttribute("data-move-side", side);
    moveFrameRef.current = frame;
  }, []);
  const clearDropPreview = useCallback((): void => {
    setPaneDragging(false);
    hideDropTarget();
    markSwap(null);
    markMove(null);
    draggedPaneRef.current = null;
  }, [hideDropTarget, markSwap, markMove]);
  const paneAreaRef = useRef<HTMLDivElement>(null);
  // a tab dragged out of its strip (lib/paneDrag.ts)
  const tabDrag = useSyncExternalStore(paneDrag.subscribe, paneDrag.snapshot);
  return { split, setSplit, soloSlot, endSplit, splitRef, splitShownRef, lastKeyAtRef, paneDragging, setPaneDragging, gridDrop, gridDropRef, showGridDrop, hideDropTarget, clearDropPreview, paneAreaRef, tabDrag, draggedPaneRef, markSwap, markMove };
}

/** what a slot other than the active one draws: its pane, read from its PC's roster */
export interface SlotView {
  target: SplitTarget;
  machine: Machine | undefined;
  pane: HerdrPane | null;
  workspace: HerdrWorkspace | null;
  herdr: HerdrIdentity | undefined;
  attach: boolean;
}

export function useSplitLayout({ machines, split, wideScreen, selectedPaneId, selectedPane, selectedMachineId, splitShownRef, health, machineRosterLoaded, endSplit, otherRecheck, otherRosterTick, setSplit, soloSlot, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setOutputStopped, splitRef, selectPane, paneAreaRef, gridDrop, gridDropRef, clearDropPreview, tabDrag, showGridDrop, hideDropTarget, setPaneDragging, movingPanes, draggedPaneRef, markSwap, markMove, swapPanes, movePanes, arrangeRefused }: {
  machines: Machine[];
  split: SplitState | null;
  wideScreen: boolean;
  selectedPaneId: string | null;
  selectedPane: HerdrPane | null;
  selectedMachineId: string;
  splitShownRef: RefObject<boolean>;
  health: HealthInfo | null;
  machineRosterLoaded: boolean;
  endSplit: (remaining: SplitSlot) => void;
  otherRecheck: RefObject<boolean>;
  otherRosterTick: number;
  setSplit: (next: SplitState | null) => void;
  soloSlot: SplitSlot;
  setConnected: Dispatch<SetStateAction<boolean>>;
  setConnectedBefore: Dispatch<SetStateAction<boolean>>;
  setSelectedMachineId: Dispatch<SetStateAction<string>>;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  setOutputStopped: Dispatch<SetStateAction<boolean>>;
  splitRef: RefObject<SplitState | null>;
  selectPane: (paneId: string, focusInput?: boolean) => void;
  paneAreaRef: RefObject<HTMLDivElement | null>;
  gridDrop: DropZone | null;
  gridDropRef: RefObject<DropZone | null>;
  clearDropPreview: () => void;
  tabDrag: PaneDrag | null;
  showGridDrop: (zone: DropZone | null) => void;
  hideDropTarget: () => void;
  setPaneDragging: Dispatch<SetStateAction<boolean>>;
  /** panes a tab move has on its way to another workspace (paneStorageId): a slot showing one waits for the move */
  movingPanes: RefObject<Set<string>>;
  draggedPaneRef: RefObject<SplitTarget | null>;
  markSwap: (head: HTMLElement | null) => void;
  markMove: (frame: HTMLElement | null, side?: PaneDirection | null) => void;
  /** herdr's pane.swap of the dragged pane and another pane of its tab */
  swapPanes: (dragged: SplitTarget, targetPaneId: string) => void;
  /** the dragged pane to that side of another pane of its tab (POST /api/pane/move) */
  movePanes: (dragged: SplitTarget, targetPaneId: string, side: PaneDirection) => void;
  /** a PC whose panes cannot be arranged (herdr-core: the Herdr app owns its splits): its pane docks in a slot instead */
  arrangeRefused: (machineId: string) => boolean;
}) {
  // The split view (lib/split.ts): drawn only where the sidebar stands beside the pane, and only
  // while a pane is selected; a narrower window shows the active slot alone and keeps the split
  const splitOn = split !== null && wideScreen && selectedPaneId !== null;
  splitShownRef.current = splitOn;
  const current: SplitTarget | null = selectedPaneId === null ? null : { machineId: selectedMachineId, paneId: selectedPaneId };
  // every slot draws on a connection of its own but slot a (App's SlotSessions), so slots may attach
  // one tab each and attach and detach it as the others are not there
  const others = new Map<SplitSlot, SlotView>();
  for (const [slot, target] of Object.entries(split?.panes ?? {})) {
    const machine = machines.find((m) => m.id === target.machineId);
    const pane = machine?.snapshot?.panes.find((item) => item.pane_id === target.paneId) ?? null;
    const workspace = pane ? machine?.snapshot?.workspaces.find((item) => item.workspace_id === pane.workspace_id) ?? null : null;
    const herdr = target.machineId === "local" ? health?.herdr : machine?.herdr;
    others.set(slot, { target, machine, pane, workspace, herdr, attach: herdr?.terminal_attach !== false || herdr?.terminal_mirror === true });
  }
  // the slots drawn, by id: a slot keeps its element (and its terminals) wherever the layout puts it.
  // One pane: the solo slot, or a split's active slot where the window is too narrow for the others
  const shownSlots: SplitSlot[] = splitOn ? [...slotsOf(split.root)].sort() : [split ? split.active : soloSlot];
  const rects: Map<SplitSlot, SplitRect> | null = splitOn ? slotRects(split.root) : null;
  // A tab shown in several slots has one pty and one size: the active slot sizes it when it shows the
  // tab, else the first slot in reading order; every other slot showing it follows (PaneFollowContext)
  const tabOf = (slot: SplitSlot): string | null => {
    if (split && slot === split.active) return selectedPane ? `${selectedMachineId}\n${selectedPane.tab_id}` : null;
    const view = others.get(slot);
    return view?.pane ? `${view.target.machineId}\n${view.pane.tab_id}` : null;
  };
  const leaders = new Map<string, SplitSlot>();
  if (splitOn) {
    for (const slot of [split.active, ...slotsOf(split.root)]) {
      const tab = tabOf(slot);
      if (tab !== null && !leaders.has(tab)) leaders.set(tab, slot);
    }
  }
  const follows = (slot: SplitSlot): boolean => {
    const tab = splitOn ? tabOf(slot) : null;
    return tab !== null && leaders.get(tab) !== slot;
  };

  // a slot's pane closed: another pane of its tab takes its place, else the slot closes. An offline
  // PC's cached roster cannot say so, as for the selection itself
  const slotTabsRef = useRef(new Map<string, string>());
  const slotKeys = new Set<string>();
  for (const view of others.values()) {
    const key = paneStorageId(view.target.machineId, view.target.paneId);
    slotKeys.add(key);
    if (view.pane) slotTabsRef.current.set(key, view.pane.tab_id);
  }
  for (const key of [...slotTabsRef.current.keys()]) if (!slotKeys.has(key)) slotTabsRef.current.delete(key);
  const applyLayout = useCallback((next: { split: SplitState | null; solo: SplitSlot }): void => {
    if (next.split === null) endSplit(next.solo); else setSplit(next.split);
  }, [endSplit, setSplit]);
  useEffect(() => {
    if (!split || !machineRosterLoaded) return;
    const moving = (target: SplitTarget): boolean => movingPanes.current.has(paneStorageId(target.machineId, target.paneId));
    const closed = new Set<SplitSlot>();
    const asks: [SplitSlot, SplitTarget][] = [];
    let next = split;
    for (const [slot, target] of Object.entries(split.panes)) {
      const machine = machines.find((m) => m.id === target.machineId);
      if (!machine) { closed.add(slot); continue; }
      if (!machine.snapshot || machine.state !== "connected") continue;
      const panes = machine.snapshot.panes;
      if (panes.some((pane) => pane.pane_id === target.paneId) || moving(target)) continue;
      const tabId = slotTabsRef.current.get(paneStorageId(target.machineId, target.paneId)) ?? null;
      // a pane this page has not seen in the roster yet (a saved split, a pane made just before the page
      // loaded) may be newer than the cached roster: ask the PC before the slot closes, as the selection does
      if (tabId === null) { asks.push([slot, target]); continue; }
      const focused = machine.snapshot.layouts.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
      const heir = panes.find((pane) => pane.tab_id === tabId && pane.pane_id === focused) ?? panes.find((pane) => pane.tab_id === tabId);
      if (heir) next = replaceSlotPane(next, slot, { machineId: target.machineId, paneId: heir.pane_id });
      else closed.add(slot);
    }
    if (closed.size > 0) { applyLayout(withoutSlots(next, closed)); return; }
    if (next !== split) { setSplit(next); return; }
    if (asks.length === 0) return;
    let cancelled = false;
    // every answer first, then one change: two slots confirmed gone must not each be closed from the same split
    void Promise.allSettled(asks.map(([, target]) => fetchSession(target.machineId))).then((answers) => {
      if (cancelled) return;
      const now = splitRef.current;
      const gone = new Set<SplitSlot>();
      answers.forEach((answer, index) => {
        const [slot, target] = asks[index]!;
        // a failed read is not evidence that the pane closed: ask again on the next roster
        if (answer.status === "rejected") { otherRecheck.current = true; return; }
        if (!moving(target) && !answer.value.panes.some((pane) => pane.pane_id === target.paneId) && now && sameTarget(now.panes[slot], target)) gone.add(slot);
      });
      if (now && gone.size > 0) applyLayout(withoutSlots(now, gone));
    });
    return () => { cancelled = true; };
  }, [split, machineRosterLoaded, machines, otherRosterTick, applyLayout, setSplit]);

  /** A split change and the pane it selects. The slot that becomes active keeps its terminals: only
   *  a slot whose pane moves to another PC attaches again and reports its connection. */
  // `keepFocus`: the focus already went somewhere in the slot made active (a Tab onto one of its
  // buttons): the slot's terminal and composer must not take the keyboard from it (autoSelected)
  const applySplit = (change: SplitChange, keepFocus = false): void => {
    const was = splitOn ? split : null;
    const after = change.split ? change.split.active : change.solo;
    const before = was ? (was.active === after ? current : was.panes[after] ?? null) : after === soloSlot ? current : null;
    if (before === null || before.machineId !== change.select.machineId) { setConnected(false); setConnectedBefore(false); }
    applyLayout(change);
    setSelectedMachineId(change.select.machineId); setSelectedPaneId(change.select.paneId); setAutoSelected(keepFocus); setOutputStopped(false);
    storeSelection(change.select.machineId, change.select.paneId);
  };
  const activateSlot = (slot: SplitSlot, keepFocus = false): void => {
    if (!splitOn || current === null) return;
    const change = activatedSlot(split, current, slot);
    if (change) applySplit(change, keepFocus);
  };
  const closeSlot = (slot: SplitSlot): void => {
    if (!splitOn || current === null) return;
    // another slot closes alone; the active one's place and the selection go to its nearest slot
    if (slot !== split.active) { applyLayout(withoutSlots(split, new Set([slot]))); return; }
    const change = closeSlots(split, current, new Set([slot]));
    if (change) applySplit(change);
  };
  const selectInSlot = (slot: SplitSlot, machineId: string, paneId: string, focusInput = true): void => {
    const open = splitRef.current;
    if (!open || !splitOn || open.active === slot) { selectPane(paneId, focusInput); return; }
    if (current === null) return;
    // a pick in another slot (a press on a sibling pane of its tab, a tab opened there) makes that slot
    // active with the picked pane selected, in one step. The press's own activation and this pick both
    // read the state from before the event: as two steps the second would undo the first
    const change = pickInSlot(open, current, slot, { machineId, paneId });
    if (change) applySplit(change, !focusInput);
  };
  /** A pane opened in a half (the pane menu, a drop without rows and columns): the slot there shows it
   *  and is the active one, or a new slot beside a single pane does; the others keep what they show. */
  const dockSide = (dragged: SplitTarget, side: SplitSide): void => {
    if (!wideScreen || current === null) return;
    // with rows and columns and room for another slot, the pane opens beside the active slot on that side
    const room = !splitOn || slotsOf(split.root).length < MAX_SPLIT_SLOTS;
    const zone = room ? { slot: splitOn ? split.active : soloSlot, edge: side } : sideZone(splitOn ? split : null, soloSlot, side);
    const change = zone ? dockPane(splitOn ? split : null, current, dragged, zone, soloSlot) : null;
    if (change) applySplit(change);
  };
  /** The zone under a point of the pane area, as the guide shows it: null outside the area. */
  const zoneAt = (x: number, y: number): DropZone | null => {
    const box = paneAreaRef.current?.getBoundingClientRect();
    if (!box || x < box.left || x >= box.right || y < box.top || y >= box.bottom) return null;
    return dropZone(x, y, box, splitOn ? split : null, soloSlot, gridDropRef.current);
  };
  const showZoneAt = (x: number, y: number): void => showGridDrop(zoneAt(x, y));
  /** A pane dropped at a point: the slot under it opens the pane, or a new slot beside it. */
  const dockAt = (dragged: SplitTarget, x: number, y: number): void => {
    const zone = zoneAt(x, y);
    clearDropPreview();
    if (zone === null || !wideScreen || current === null) return;
    const change = dockPane(splitOn ? split : null, current, dragged, zone, soloSlot);
    if (change) applySplit(change);
  };
  const dockAtRef = useRef(dockAt); dockAtRef.current = dockAt;
  useEffect(() => {
    paneDrag.onDrop((target, x, y) => dockAtRef.current(target, x, y));
    return () => paneDrag.onDrop(null);
  }, []);
  // a tab dragged out of its strip: the guide follows it as a sidebar row's drag does below
  const splitDragOn = wideScreen && selectedPaneId !== null;
  const showZoneAtRef = useRef(showZoneAt); showZoneAtRef.current = showZoneAt;
  useEffect(() => {
    if (!tabDrag || !splitDragOn) { if (!tabDrag) hideDropTarget(); return; }
    const point = tabDrag.point;
    if (point) showZoneAtRef.current(point.x, point.y); else hideDropTarget();
  }, [tabDrag, splitDragOn, hideDropTarget]);
  // the boundaries between slots, moved by a drag or the arrow keys (SplitDividers), with rows and columns only
  const dividers = splitOn ? splitDividers(split.root) : [];
  const resizeDivider = useCallback((path: string, ratio: number): void => {
    const open = splitRef.current;
    if (!open) return;
    const next = resizeSplit(open, path, ratio);
    if (next !== open) setSplit(next);
  }, [setSplit]);
  // the guide with rows and columns: every slot outlined, and the place the pane would take
  const gridPreview = {
    zone: gridDrop,
    slots: rects ? [...rects.values()] : [{ x: 0, y: 0, w: 1, h: 1 }],
    target: gridDrop ? zoneRect(gridDrop, splitOn ? split : null, soloSlot) : null,
  };
  // dragenter too: a drop hit-tests once more, and when the node under the pointer was replaced since
  // the last dragover (xterm redraws its rows, a transcript renders again) the new node gets a
  // dragenter instead. Chromium refuses a drop whose last drag event nobody accepted.
  /** The title of another pane in the dragged pane's own tab, under the pointer: dropped there, the
   *  two trade places (herdr's pane.swap) instead of opening the pane in a half. */
  const swapHead = (target: EventTarget | null): HTMLElement | null => {
    const dragged = draggedPaneRef.current;
    const head = target instanceof Element ? target.closest<HTMLElement>(".pane-frame-head") : null;
    const slot = head?.closest<HTMLElement>(".pane-slot");
    const paneId = head?.parentElement?.getAttribute("data-layout-pane");
    if (!dragged || !head || !slot || !paneId || paneId === dragged.paneId || slot.dataset.machine !== dragged.machineId) return null;
    // the dragged pane drawn in the same canvas is in the same tab, the only place herdr swaps in
    return slot.querySelector(`.pane-frame:not(.is-hidden)[data-layout-pane="${CSS.escape(dragged.paneId)}"]`) ? head : null;
  };
  /** Over the canvas of its own tab, drawn with another pane, a pane's title arranges the tab: dropped
   *  on another pane's body, it goes to the side of it nearest the pointer (herdr's pane.move), and on
   *  itself nowhere ("none"). Null elsewhere, where a drop opens a half as before: the other half
   *  showing another tab, a single pane's canvas, anything outside a canvas. */
  const besideAt = (target: EventTarget | null, x: number, y: number): { frame: HTMLElement; paneId: string; side: PaneDirection } | "none" | null => {
    const dragged = draggedPaneRef.current;
    const canvas = target instanceof Element ? target.closest<HTMLElement>(".pane-canvas") : null;
    if (!dragged || !canvas || canvas.closest<HTMLElement>(".pane-slot")?.dataset.machine !== dragged.machineId) return null;
    const shown = [...canvas.querySelectorAll<HTMLElement>(".pane-frame:not(.is-hidden)")];
    if (shown.length < 2 || !shown.some((frame) => frame.dataset.layoutPane === dragged.paneId)) return null;
    const frame = (target as Element).closest<HTMLElement>(".pane-frame:not(.is-hidden)");
    const paneId = frame?.dataset.layoutPane;
    if (!frame || !paneId || paneId === dragged.paneId) return "none";
    return { frame, paneId, side: besideSide(x, y, frame.getBoundingClientRect(), frame.getAttribute("data-move-side") as PaneDirection | null) };
  };
  const paneDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!splitDragOn || !event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    event.preventDefault();
    const dragging = draggedPaneRef.current;
    const refused = dragging !== null && arrangeRefused(dragging.machineId);
    const head = refused ? null : swapHead(event.target);
    const beside = refused || head ? null : besideAt(event.target, event.clientX, event.clientY);
    // over the dragged pane itself a drop does nothing, and the pointer says so
    event.dataTransfer.dropEffect = beside === "none" ? "none" : "move";
    markSwap(head);
    if (beside && beside !== "none") markMove(beside.frame, beside.side); else markMove(null);
    setPaneDragging(head === null && beside === null);
    if (head || beside) { hideDropTarget(); return; }
    showZoneAt(event.clientX, event.clientY);
  };
  const paneDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    // Some browsers omit relatedTarget when crossing a child. The pointer still being inside
    // the area must not clear the preview (or its stable side at the centre).
    const box = event.currentTarget.getBoundingClientRect();
    if (event.relatedTarget === null && event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom) return;
    hideDropTarget();
    markSwap(null);
    markMove(null);
  };
  const paneDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    // the composer and the terminal take dropped files: a dropped pane is not one
    event.preventDefault();
    event.stopPropagation();
    const dragged = draggedPane(event.dataTransfer.getData(PANE_DRAG_TYPE));
    const refused = !dragged || arrangeRefused(dragged.machineId);
    const target = refused ? null : swapHead(event.target)?.parentElement?.getAttribute("data-layout-pane");
    // read before the preview clears: the side shown is the side taken
    const beside = refused || target ? null : besideAt(event.target, event.clientX, event.clientY);
    if (dragged && target) {
      clearDropPreview();
      swapPanes(dragged, target);
    } else if (dragged && beside) {
      clearDropPreview();
      if (beside !== "none") movePanes(dragged, beside.paneId, beside.side);
    } else if (dragged) dockAt(dragged, event.clientX, event.clientY);
    else clearDropPreview();
  };
  // Bubble phase: the sidebar row has put its pane type into DataTransfer by then.
  useEffect(() => {
    if (!splitDragOn) { clearDropPreview(); return; }
    const start = (event: globalThis.DragEvent): void => {
      if (event.dataTransfer?.types.includes(PANE_DRAG_TYPE)) {
        const fromTitle = event.target instanceof Element && event.target.closest(".pane-frame-head") !== null;
        draggedPaneRef.current = fromTitle ? draggedPane(event.dataTransfer.getData(PANE_DRAG_TYPE)) : null;
        hideDropTarget();
        // a title starts over its own tab, where it arranges the tab: the guide waits for a dragover that offers a slot
        setPaneDragging(!fromTitle);
      }
    };
    const cancel = (event: KeyboardEvent): void => { if (event.key === "Escape") clearDropPreview(); };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", clearDropPreview);
    window.addEventListener("drop", clearDropPreview);
    window.addEventListener("blur", clearDropPreview);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", clearDropPreview);
      window.removeEventListener("drop", clearDropPreview);
      window.removeEventListener("blur", clearDropPreview);
      window.removeEventListener("keydown", cancel);
    };
  }, [splitDragOn, clearDropPreview, hideDropTarget]);
  return { splitOn, others, shownSlots, rects, follows, activateSlot, closeSlot, selectInSlot, dockSide, splitDragOn, paneDragOver, paneDragLeave, paneDrop, dividers, resizeDivider, gridPreview };
}
