import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { HerdrTab, TabMoved } from "../../shared/protocol.ts";
import { adjacentTabBoundary, movedTabOrder, tabDropBoundary } from "./tabOrder.ts";

type Drag = { tabId: string; boundary: number | null };
type Press = { tabId: string; pointerId: number; element: HTMLElement; x: number; y: number; startX: number; startY: number; started: boolean };
type Operation = { expected: string | null; settled: boolean; timer?: number };
/** where a tab dragged out of the strip goes: the pane area opens its pane in a half (lib/paneDrag.ts) */
export interface TabDragOut {
  start: (tabId: string) => void;
  move: (x: number, y: number) => void;
  back: () => void;
  drop: (x: number, y: number) => void;
  cancel: () => void;
}

/**
 * A drag previews only an insertion line. Herdr's next snapshot owns the actual order.
 * `fixed`: the order is not this client's to change (the Herdr app's window lays the PC out,
 * lib/machineContext.tsx AppLayoutContext): no insertion line and no move, as among one tab; a
 * drag can still leave the strip (`outside`).
 */
export function useTabReorder({ owner, tabs, strip, moveTab, failed, stale, outside, fixed = false }: {
  owner: string;
  tabs: HerdrTab[];
  strip: RefObject<HTMLDivElement | null>;
  moveTab: (tabId: string, boundary: number) => Promise<TabMoved>;
  failed: (error: unknown) => void;
  stale: () => void;
  outside?: TabDragOut;
  fixed?: boolean;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [moving, setMoving] = useState(false);
  const ids = tabs.map((tab) => tab.tab_id);
  const key = JSON.stringify(ids);
  const current = useRef({ owner, key, ids, moveTab, failed, stale, outside, fixed });
  current.current = { owner, key, ids, moveTab, failed, stale, outside, fixed };
  const press = useRef<Press | null>(null);
  const operation = useRef<Operation | null>(null);
  const suppressClick = useRef(false);
  const animation = useRef<number | null>(null);

  const cancelDrag = (): void => {
    const held = press.current;
    press.current = null;
    if (held?.started) { suppressClick.current = true; current.current.outside?.cancel(); }
    if (held?.element.hasPointerCapture(held.pointerId)) held.element.releasePointerCapture(held.pointerId);
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    setDrag(null);
  };
  const finishOperation = (op: Operation): void => {
    if (operation.current !== op) return;
    if (op.timer !== undefined) window.clearTimeout(op.timer);
    operation.current = null;
    setMoving(false);
  };
  useLayoutEffect(() => {
    return () => {
      cancelDrag();
      const op = operation.current;
      if (op?.timer !== undefined) window.clearTimeout(op.timer);
      operation.current = null;
    };
  }, [owner]);
  useLayoutEffect(() => {
    cancelDrag();
    // An external create/close/reorder cancels a drag. A sent request still holds the gate
    // until the order in its answer has been observed. An unrelated snapshot received before
    // the answer is not an acknowledgement, and must not enable another stale-coordinate move.
    const op = operation.current;
    if (op?.settled && key === op.expected) finishOperation(op);
  }, [key, owner]);
  useLayoutEffect(() => {
    setMoving(false);
    suppressClick.current = false;
  }, [owner]);

  const requestMove = (tabId: string, boundary: number): void => {
    if (operation.current || current.current.fixed || !movedTabOrder(current.current.ids, tabId, boundary)) return;
    cancelDrag();
    const saved = current.current;
    const op: Operation = { expected: null, settled: false };
    operation.current = op;
    setMoving(true);
    void saved.moveTab(tabId, boundary).then((result) => {
      if (operation.current !== op || current.current.owner !== saved.owner) return;
      op.expected = JSON.stringify(result.tabs.map((tab) => tab.tab_id));
      op.settled = true;
      if (current.current.key === op.expected) finishOperation(op);
      // Concurrent native edits may supersede this order before it is published. Give the gate
      // a deadline and report that the expected snapshot never arrived rather than getting stuck.
      else op.timer = window.setTimeout(() => {
        if (operation.current !== op) return;
        finishOperation(op);
        current.current.stale();
      }, 8000);
    }).catch((reason: unknown) => {
      if (operation.current !== op || current.current.owner !== saved.owner) return;
      finishOperation(op);
      saved.failed(reason);
    });
  };
  const moveAdjacent = (tabId: string, direction: -1 | 1): void => {
    const boundary = adjacentTabBoundary(current.current.ids, tabId, direction);
    if (boundary !== null) requestMove(tabId, boundary);
  };
  const overStrip = (held: Press): boolean => {
    const box = strip.current?.getBoundingClientRect();
    return !!box && held.y >= box.top - 12 && held.y <= box.bottom + 12 && held.x >= box.left - 12 && held.x <= box.right + 12;
  };
  const boundaryAt = (held: Press): number | null => {
    const row = strip.current;
    if (!row || !overStrip(held) || current.current.ids.length < 2 || current.current.fixed) return null;
    const rects = [...row.querySelectorAll<HTMLElement>(".tab-strip-item")].map((item) => item.getBoundingClientRect());
    return tabDropBoundary(rects, held.x);
  };
  const paintDrag = (held: Press): void => {
    const boundary = boundaryAt(held);
    setDrag((old) => old?.tabId === held.tabId && old.boundary === boundary ? old : { tabId: held.tabId, boundary });
  };
  const tick = (): void => {
    const held = press.current;
    const row = strip.current;
    if (!held?.started || !row) { animation.current = null; return; }
    const box = row.getBoundingClientRect();
    const right = row.querySelector<HTMLElement>(".tab-strip-add")?.getBoundingClientRect().left ?? box.right;
    if (held.y >= box.top - 12 && held.y <= box.bottom + 12) {
      const direction = held.x < box.left + 28 ? -1 : held.x > right - 28 ? 1 : 0;
      if (direction) { row.scrollLeft += direction * 8; paintDrag(held); }
    }
    animation.current = requestAnimationFrame(tick);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>, tabId: string): void => {
    // Touch keeps its native swipe scroll; its menu offers the same adjacent moves.
    if (event.pointerType !== "mouse" || event.button !== 0 || event.ctrlKey || !event.isPrimary) return;
    suppressClick.current = false;
    if (operation.current || ((current.current.ids.length < 2 || current.current.fixed) && !current.current.outside)) return;
    event.preventDefault(); // dragging an inactive tab must not steal terminal or keyboard focus
    const element = event.currentTarget;
    press.current = { tabId, pointerId: event.pointerId, element, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, started: false };
    element.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const held = press.current;
    if (!held || event.pointerId !== held.pointerId) return;
    held.x = event.clientX; held.y = event.clientY;
    if (!held.started) {
      if (Math.hypot(held.x - held.startX, held.y - held.startY) < 6) return;
      held.started = true;
      suppressClick.current = true;
      animation.current = requestAnimationFrame(tick);
      current.current.outside?.start(held.tabId);
    }
    paintDrag(held);
    if (overStrip(held)) current.current.outside?.back();
    else current.current.outside?.move(held.x, held.y);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const held = press.current;
    if (!held || event.pointerId !== held.pointerId) return;
    held.x = event.clientX; held.y = event.clientY;
    const boundary = held.started ? boundaryAt(held) : null;
    if (held.started && !overStrip(held)) current.current.outside?.drop(held.x, held.y);
    cancelDrag();
    if (boundary !== null) requestMove(held.tabId, boundary);
  };
  useLayoutEffect(() => {
    if (!drag) return;
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); cancelDrag();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancelDrag);
    return () => { window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", cancelDrag); };
  }, [drag?.tabId]);

  return { drag, moving, moveAdjacent, cancelDrag, onPointerDown, onPointerMove, onPointerUp,
    consumeClick: (detail: number): boolean => { const suppress = detail !== 0 && suppressClick.current; suppressClick.current = false; return suppress; } };
}
