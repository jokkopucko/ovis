import { type Dispatch, type DragEvent, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { fetchSession, type HealthInfo } from "./api.ts";
import { dockPane, draggedPane, dropSide, otherSlot, PANE_DRAG_TYPE, sameTarget, storedSplit, storeSplit, type SplitSide, type SplitSlot, type SplitState, type SplitTarget } from "./split.ts";
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
  // two tabs side by side (lib/split.ts): the other half's pane, its side, and the active slot.
  // Only drawn where the sidebar stands beside the pane; a narrower window shows the active half
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
  const [dropAt, setDropAt] = useState<SplitSide | null>(null);
  const dropAtRef = useRef<SplitSide | null>(null);
  const showDropTarget = useCallback((side: SplitSide | null): void => {
    dropAtRef.current = side;
    setDropAt(side);
  }, []);
  // the pane being dragged, read at dragstart (a dragover cannot read the drag's data), and the
  // title it would trade places with if dropped now. Only a drag from the pane's own title swaps:
  // a sidebar row, a tab or a half's bar dropped on a title still opens a half
  const draggedPaneRef = useRef<SplitTarget | null>(null);
  const swapHeadRef = useRef<HTMLElement | null>(null);
  const markSwap = useCallback((head: HTMLElement | null): void => {
    if (swapHeadRef.current === head) return;
    swapHeadRef.current?.classList.remove("is-swap-target");
    head?.classList.add("is-swap-target");
    swapHeadRef.current = head;
  }, []);
  const clearDropPreview = useCallback((): void => {
    setPaneDragging(false);
    showDropTarget(null);
    markSwap(null);
    draggedPaneRef.current = null;
  }, [showDropTarget, markSwap]);
  const paneAreaRef = useRef<HTMLDivElement>(null);
  // a tab dragged out of its strip (lib/paneDrag.ts)
  const tabDrag = useSyncExternalStore(paneDrag.subscribe, paneDrag.snapshot);
  return { split, setSplit, soloSlot, endSplit, splitRef, splitShownRef, lastKeyAtRef, paneDragging, setPaneDragging, dropAt, dropAtRef, showDropTarget, clearDropPreview, paneAreaRef, tabDrag, draggedPaneRef, markSwap };
}

export function useSplitLayout({ machines, split, wideScreen, selectedPaneId, selectedPane, selectedMachineId, splitShownRef, health, machineRosterLoaded, endSplit, otherRecheck, otherRosterTick, setSplit, soloSlot, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setOutputStopped, splitRef, selectPane, paneAreaRef, dropAtRef, clearDropPreview, tabDrag, showDropTarget, setPaneDragging, movingPanes, draggedPaneRef, markSwap, swapPanes, swapRefused }: {
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
  dropAtRef: RefObject<SplitSide | null>;
  clearDropPreview: () => void;
  tabDrag: PaneDrag | null;
  showDropTarget: (side: SplitSide | null) => void;
  setPaneDragging: Dispatch<SetStateAction<boolean>>;
  /** panes a tab move has on its way to another workspace (paneStorageId): the other half waits for the move */
  movingPanes: RefObject<Set<string>>;
  draggedPaneRef: RefObject<SplitTarget | null>;
  markSwap: (head: HTMLElement | null) => void;
  /** herdr's pane.swap of the dragged pane and another pane of its tab */
  swapPanes: (dragged: SplitTarget, targetPaneId: string) => void;
  /** a PC whose panes cannot swap (herdr-core: the Herdr app owns its splits): its pane docks in a half instead */
  swapRefused: (machineId: string) => boolean;
}) {
  // The split view (lib/split.ts): drawn only where the sidebar stands beside the pane, and only
  // while a pane is selected; a narrower window shows the active half alone and keeps the split
  const otherMachine = split ? machines.find((m) => m.id === split.other.machineId) : undefined;
  const otherPane = split ? otherMachine?.snapshot?.panes.find((pane) => pane.pane_id === split.other.paneId) ?? null : null;
  // both halves may show one tab: slot b draws on a connection of its own (the slot's
  // MachineSessionsProvider below), so each half attaches and detaches the tab's panes by itself
  const splitOn = split !== null && wideScreen && selectedPaneId !== null;
  // the half that is not active, drawing the active half's tab too, shows it at the grid the active
  // half gives the pane: one pty has one size (PaneFollowContext)
  const sameTabs = splitOn && otherPane !== null && selectedPane !== null
    && split.other.machineId === selectedMachineId && otherPane.tab_id === selectedPane.tab_id;
  splitShownRef.current = splitOn;
  const otherWorkspace = otherPane ? otherMachine?.snapshot?.workspaces.find((workspace) => workspace.workspace_id === otherPane.workspace_id) ?? null : null;
  const otherHerdr = split?.other.machineId === "local" ? health?.herdr : otherMachine?.herdr;
  const otherAttach = otherHerdr?.terminal_attach !== false || otherHerdr?.terminal_mirror === true;

  // the other half's pane closed: another pane of its tab takes its place, else back to one pane.
  // An offline PC's cached roster cannot say so, as for the selection itself
  const otherTabRef = useRef<{ key: string; tab: string } | null>(null);
  const otherKey = split ? `${split.other.machineId}:${split.other.paneId}` : null;
  if (otherPane && otherKey) otherTabRef.current = { key: otherKey, tab: otherPane.tab_id };
  else if (otherTabRef.current?.key !== otherKey) otherTabRef.current = null;
  useEffect(() => {
    if (!split || !machineRosterLoaded) return;
    if (!otherMachine) { endSplit(split.active); return; }
    if (!otherMachine.snapshot || otherMachine.state !== "connected") return;
    const panes = otherMachine.snapshot.panes;
    if (panes.some((pane) => pane.pane_id === split.other.paneId)) return;
    const moving = (): boolean => movingPanes.current.has(paneStorageId(split.other.machineId, split.other.paneId));
    if (moving()) return;
    const tabId = otherTabRef.current?.tab ?? null;
    // a pane this page has not seen in the roster yet (a saved split, a pane made just before the page
    // loaded) may be newer than the cached roster: ask the PC before the split ends, as the selection does
    if (tabId === null) {
      let cancelled = false;
      const other = split.other;
      void fetchSession(other.machineId).then((current) => {
        if (!cancelled && !moving() && !current.panes.some((pane) => pane.pane_id === other.paneId)) endSplit(split.active);
      }).catch(() => {
        // a failed read is not evidence that the pane closed: ask again on the next roster
        if (!cancelled) otherRecheck.current = true;
      });
      return () => { cancelled = true; };
    }
    const focused = otherMachine.snapshot.layouts.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
    const heir = panes.find((pane) => pane.tab_id === tabId && pane.pane_id === focused) ?? panes.find((pane) => pane.tab_id === tabId);
    if (heir) setSplit({ ...split, other: { machineId: split.other.machineId, paneId: heir.pane_id } });
    else endSplit(split.active);
  }, [split, machineRosterLoaded, otherMachine, otherRosterTick, endSplit, setSplit]);

  /** A split change and the pane it selects. The half that becomes active keeps its terminals: only
   *  a half whose pane moves to another PC attaches again and reports its connection. */
  // `keepFocus`: the focus already went somewhere in the half made active (a Tab onto one of its
  // buttons): the half's terminal and composer must not take the keyboard from it (autoSelected)
  const applySplit = (next: SplitState | null, select: SplitTarget, keepFocus = false): void => {
    const was = splitOn ? split : null;
    const current: SplitTarget | null = selectedPaneId === null ? null : { machineId: selectedMachineId, paneId: selectedPaneId };
    const after: SplitSlot = next ? next.active : was && sameTarget(select, was.other) ? otherSlot(was.active) : was ? was.active : soloSlot;
    const before = was ? (was.active === after ? current : was.other) : after === soloSlot ? current : null;
    if (before === null || before.machineId !== select.machineId) { setConnected(false); setConnectedBefore(false); }
    if (next === null) endSplit(after); else setSplit(next);
    setSelectedMachineId(select.machineId); setSelectedPaneId(select.paneId); setAutoSelected(keepFocus); setOutputStopped(false);
    storeSelection(select.machineId, select.paneId);
  };
  const activateSlot = (slot: SplitSlot, keepFocus = false): void => {
    if (!splitOn || split.active === slot || selectedPaneId === null) return;
    applySplit({ other: { machineId: selectedMachineId, paneId: selectedPaneId }, bSide: split.bSide, active: slot }, split.other, keepFocus);
  };
  const closeSlot = (slot: SplitSlot): void => {
    if (!splitOn) return;
    if (slot !== split.active) { endSplit(split.active); return; }
    applySplit(null, split.other);
  };
  const selectInSlot = (slot: SplitSlot, machineId: string, paneId: string, focusInput = true): void => {
    const open = splitRef.current;
    if (!open || !splitOn || open.active === slot) { selectPane(paneId, focusInput); return; }
    if (selectedPaneId === null) return;
    // a pick in the other half (a press on a sibling pane of its tab, a tab opened there) makes that half
    // active with the picked pane selected, in one step. The press's own activation and this pick both
    // read the state from before the event: as two steps the second would undo the first
    applySplit({ other: { machineId: selectedMachineId, paneId: selectedPaneId }, bSide: open.bSide, active: slot }, { machineId, paneId }, !focusInput);
  };
  /** A pane opened in one half (a drop, the pane menu): that half shows it and is the active one; the
   *  other half keeps what it shows, the same tab included (lib/split.ts). */
  const dockSide = (dragged: SplitTarget, side: SplitSide): void => {
    if (!wideScreen || selectedPaneId === null) return;
    const result = dockPane(splitOn ? split : null, { machineId: selectedMachineId, paneId: selectedPaneId }, dragged, side, soloSlot);
    if (result) applySplit(result.split, result.select);
  };
  /** A pane dropped at a point: the half under it opens the pane. */
  const dockAt = (dragged: SplitTarget, x: number, y: number): void => {
    const box = paneAreaRef.current?.getBoundingClientRect();
    const inside = !!box && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    const side = box && inside ? dropSide(x, box.left, box.width, dropAtRef.current) : null;
    clearDropPreview();
    if (side !== null) dockSide(dragged, side);
  };
  const dockAtRef = useRef(dockAt); dockAtRef.current = dockAt;
  useEffect(() => {
    paneDrag.onDrop((target, x, y) => dockAtRef.current(target, x, y));
    return () => paneDrag.onDrop(null);
  }, []);
  // a tab dragged out of its strip: the guide follows it as a sidebar row's drag does below
  const splitDragOn = wideScreen && selectedPaneId !== null;
  useEffect(() => {
    if (!tabDrag || !splitDragOn) { if (!tabDrag) showDropTarget(null); return; }
    const box = paneAreaRef.current?.getBoundingClientRect();
    const point = tabDrag.point;
    const inside = !!box && !!point && point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;
    showDropTarget(box && point && inside ? dropSide(point.x, box.left, box.width, dropAtRef.current) : null);
  }, [tabDrag, splitDragOn, showDropTarget]);
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
  const paneDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!splitDragOn || !event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const dragging = draggedPaneRef.current;
    const head = dragging && swapRefused(dragging.machineId) ? null : swapHead(event.target);
    markSwap(head);
    setPaneDragging(head === null);
    if (head) { showDropTarget(null); return; }
    const box = paneAreaRef.current?.getBoundingClientRect();
    if (box) showDropTarget(dropSide(event.clientX, box.left, box.width, dropAtRef.current));
  };
  const paneDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    // Some browsers omit relatedTarget when crossing a child. The pointer still being inside
    // the area must not clear the preview (or its stable side at the centre).
    const box = event.currentTarget.getBoundingClientRect();
    if (event.relatedTarget === null && event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom) return;
    showDropTarget(null);
    markSwap(null);
  };
  const paneDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    // the composer and the terminal take dropped files: a dropped pane is not one
    event.preventDefault();
    event.stopPropagation();
    const dragged = draggedPane(event.dataTransfer.getData(PANE_DRAG_TYPE));
    const target = dragged && swapRefused(dragged.machineId) ? null : swapHead(event.target)?.parentElement?.getAttribute("data-layout-pane");
    if (dragged && target) {
      clearDropPreview();
      swapPanes(dragged, target);
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
        showDropTarget(null);
        setPaneDragging(true);
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
  }, [splitDragOn, clearDropPreview, showDropTarget]);
  return { otherMachine, otherPane, splitOn, sameTabs, otherWorkspace, otherHerdr, otherAttach, activateSlot, closeSlot, selectInSlot, dockSide, splitDragOn, paneDragOver, paneDragLeave, paneDrop };
}
