/*
 * On iOS a long press lifts the system's drag preview, but the drop never reaches the page, so a
 * touch screen reorders through these touch listeners and the row's `draggable` is off there.
 *
 * Once a row is up the stroke is the row's: its moves scroll nothing and never reach the drawer's
 * swipe (lib/edgeSwipe.ts, on the document's capture phase, which this listener on the window's
 * capture phase runs before).
 */

export const HOLD_MS = 400;
export const HOLD_SLOP_PX = 8;
export const EDGE_ZONE_PX = 48;
export const EDGE_SPEED_PX = 14;

export interface RowBox { id: string; top: number; bottom: number }

export function heldStill(dx: number, dy: number): boolean {
  return Math.abs(dx) <= HOLD_SLOP_PX && Math.abs(dy) <= HOLD_SLOP_PX;
}

export function rowAt(y: number, rows: readonly RowBox[]): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const row of rows) {
    if (y >= row.top && y < row.bottom) return row.id;
    const distance = y < row.top ? row.top - y : y - row.bottom;
    if (best === null || distance < best.distance) best = { id: row.id, distance };
  }
  return best?.id ?? null;
}

export function edgeScrollStep(y: number, top: number, bottom: number): number {
  const zone = Math.min(EDGE_ZONE_PX, (bottom - top) / 4);
  if (zone <= 0) return 0;
  if (y < top + zone) return -Math.round(EDGE_SPEED_PX * Math.min(1, (top + zone - y) / zone));
  if (y > bottom - zone) return Math.round(EDGE_SPEED_PX * Math.min(1, (y - (bottom - zone)) / zone));
  return 0;
}

export interface TouchReorderHandlers {
  canLift: (id: string) => boolean;
  onLift: (id: string) => void;
  onOver: (id: string | null) => void;
  onDrop: (id: string, target: string | null) => void;
  onCancel: () => void;
}

const ROW = ".workspace-group[data-workspace]";
const HANDLE = ".workspace-select";
const SCROLLER = ".machine-list";

export function watchTouchReorder(root: HTMLElement, handlers: TouchReorderHandlers): () => void {
  let press: { id: string; row: HTMLElement; x: number; y: number; timer: number } | null = null;
  let lift: {
    id: string;
    row: HTMLElement;
    scroller: HTMLElement | null;
    startY: number;
    startScroll: number;
    y: number;
    frame: number;
    over: string | null;
  } | null = null;

  const clearPress = (): void => {
    if (press !== null) window.clearTimeout(press.timer);
    press = null;
  };

  const boxes = (): RowBox[] => {
    if (lift === null) return [];
    const scrolled = lift.scroller ? lift.scroller.scrollTop - lift.startScroll : 0;
    const offset = lift.y - lift.startY + scrolled;
    const rows: RowBox[] = [];
    for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
      const id = row.dataset.workspace;
      const box = row.getBoundingClientRect();
      if (!id || box.height === 0) continue;
      rows.push(row === lift.row ? { id, top: box.top - offset, bottom: box.bottom - offset } : { id, top: box.top, bottom: box.bottom });
    }
    return rows;
  };

  const place = (): void => {
    if (lift === null) return;
    const scrolled = lift.scroller ? lift.scroller.scrollTop - lift.startScroll : 0;
    lift.row.style.transform = `translateY(${lift.y - lift.startY + scrolled}px)`;
    const over = rowAt(lift.y, boxes());
    if (over !== lift.over) {
      lift.over = over;
      handlers.onOver(over);
    }
  };

  const edgeScroll = (): void => {
    if (lift === null) return;
    lift.frame = 0;
    const scroller = lift.scroller;
    if (scroller === null) return;
    const box = scroller.getBoundingClientRect();
    const step = edgeScrollStep(lift.y, box.top, box.bottom);
    if (step === 0) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    if (scroller.scrollTop !== before) place();
    lift.frame = window.requestAnimationFrame(edgeScroll);
  };

  const pickUp = (): void => {
    if (press === null) return;
    const { id, row, y } = press;
    press = null;
    if (!row.isConnected || !handlers.canLift(id)) return;
    const scroller = row.closest<HTMLElement>(SCROLLER);
    lift = { id, row, scroller, startY: y, startScroll: scroller?.scrollTop ?? 0, y, frame: 0, over: id };
    row.style.transition = "none";
    // a long press may have begun selecting the title: the lifted row drags, it does not select
    document.getSelection?.()?.removeAllRanges();
    navigator.vibrate?.(8);
    handlers.onLift(id);
    handlers.onOver(id);
  };

  const putDown = (): void => {
    if (lift === null) return;
    if (lift.frame !== 0) window.cancelAnimationFrame(lift.frame);
    lift.row.style.transform = "";
    lift.row.style.transition = "";
    lift = null;
  };

  const onStart = (event: TouchEvent): void => {
    clearPress();
    if (lift !== null) {
      putDown();
      handlers.onCancel();
      return;
    }
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch) return;
    const target = event.target as Element | null;
    if (!target || !root.contains(target) || target.closest("input, button") !== null) return;
    const handle = target.closest(HANDLE);
    const row = handle?.closest<HTMLElement>(ROW);
    const id = row?.dataset.workspace;
    if (!row || !id || !root.contains(row)) return;
    press = { id, row, x: touch.clientX, y: touch.clientY, timer: window.setTimeout(pickUp, HOLD_MS) };
  };

  const onMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch) return;
    if (press !== null) {
      if (!heldStill(touch.clientX - press.x, touch.clientY - press.y)) clearPress();
      return;
    }
    if (lift === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lift.y = touch.clientY;
    place();
    if (lift.frame === 0) lift.frame = window.requestAnimationFrame(edgeScroll);
  };

  const onEnd = (event: TouchEvent): void => {
    clearPress();
    if (lift === null) return;
    // the click a lifted finger would make is not a tap on the row
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    const { id } = lift;
    const target = rowAt(lift.y, boxes());
    putDown();
    handlers.onDrop(id, target);
  };

  const onCancel = (): void => {
    clearPress();
    if (lift === null) return;
    putDown();
    handlers.onCancel();
  };

  // a long press opens no menu while it lifts a row
  const onContextMenu = (event: Event): void => {
    if (press !== null || lift !== null) event.preventDefault();
  };

  window.addEventListener("touchstart", onStart, { capture: true, passive: true });
  window.addEventListener("touchmove", onMove, { capture: true, passive: false });
  window.addEventListener("touchend", onEnd, { capture: true, passive: false });
  window.addEventListener("touchcancel", onCancel, { capture: true, passive: true });
  root.addEventListener("contextmenu", onContextMenu);
  return () => {
    clearPress();
    if (lift !== null) {
      putDown();
      handlers.onCancel();
    }
    window.removeEventListener("touchstart", onStart, { capture: true });
    window.removeEventListener("touchmove", onMove, { capture: true });
    window.removeEventListener("touchend", onEnd, { capture: true });
    window.removeEventListener("touchcancel", onCancel, { capture: true });
    root.removeEventListener("contextmenu", onContextMenu);
  };
}
