import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import "./SidebarSplit.css";

import { useT } from "../lib/i18n.ts";
import { clampSplit, keyedSplit, sectionAt, splitBounds, splitDrag, splitPercent, type SplitFold, type SplitOrder, type SplitRoom, type SplitSide } from "../lib/sidebarSplit.ts";

export interface SidebarSplitProps {
  shell: RefObject<HTMLDivElement | null>;
  order: SplitOrder;
  split: number | null;
  controls: string;
  onSplit(height: number | null): void;
  onFold(sections: readonly SplitFold[]): void;
}

interface Parts { top: HTMLElement; bottom: HTMLElement; footer: HTMLElement }

const HEAD: Record<SplitFold, { section: string; head: string | null }> = {
  pcs: { section: ".pcs-sidebar", head: null },
  agents: { section: ".agents-sidebar", head: ".agent-section-toggle" },
};

function parts(shell: HTMLElement | null, order: SplitOrder): Parts | null {
  const top = shell?.querySelector<HTMLElement>(`:scope > ${HEAD[sectionAt("top", order)].section}`);
  const bottom = shell?.querySelector<HTMLElement>(`:scope > ${HEAD[sectionAt("bottom", order)].section}`);
  const footer = shell?.querySelector<HTMLElement>(":scope > .sidebar-footer");
  return top && bottom && footer ? { top, bottom, footer } : null;
}

function allocation({ top }: Parts, line: HTMLElement): number {
  return Math.round(line.getBoundingClientRect().top - top.getBoundingClientRect().top);
}

function measure({ top, bottom, footer }: Parts, line: HTMLElement, order: SplitOrder): SplitRoom {
  const head = (section: HTMLElement, side: SplitSide) => {
    const selector = HEAD[sectionAt(side, order)].head;
    const box = selector === null ? undefined : section.querySelector(selector)?.getBoundingClientRect();
    const from = section.getBoundingClientRect().top;
    return { height: Math.round((box?.bottom ?? from) - from), row: box?.height ?? 0 };
  };
  const above = head(top, "top");
  const under = head(bottom, "bottom");
  const foot = footer.getBoundingClientRect();
  const end = footer.parentElement?.getBoundingClientRect().bottom ?? foot.bottom;
  const row = Math.round(above.row || under.row) || 1;
  const rowHeight = (section: HTMLElement, side: SplitSide) => {
    if (sectionAt(side, order) === "pcs") {
      const list = section.querySelector(".machine-list");
      const first = list?.querySelector(":is(.machine-header, .workspace-header, .machine-new-row)");
      if (!list || !first) return row;
      // the built-in browser's tab group sits under the list in this section (MachineSidebar.tsx): its height comes on top,
      // so the first PC row still shows at the minimum
      const browser = section.querySelector(".browser-tabs")?.getBoundingClientRect().height ?? 0;
      return Math.ceil(list.getBoundingClientRect().top - section.getBoundingClientRect().top + first.getBoundingClientRect().height + browser);
    }
    const agent = section.querySelector(".agent-row");
    return agent ? parseFloat(getComputedStyle(agent).minHeight) || row : row;
  };
  return {
    topHead: above.height,
    bottomHead: under.height,
    // Measure available room, not the footer's current top: an oversized saved split may have pushed it down.
    room: Math.max(0, Math.round(end - foot.height - top.getBoundingClientRect().top - line.getBoundingClientRect().height)),
    row,
    topRow: rowHeight(top, "top"),
    bottomRow: rowHeight(bottom, "bottom"),
  };
}

/**
 * Dragged to within about a row of a section's head, that section snaps to its head and dims, and folds
 * when let go, as VS Code's views and a macOS split view's panes do, with no words of their own to say so.
 */
export function SidebarSplit({ shell, order, split, controls, onSplit, onFold }: SidebarSplitProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number; room: SplitRoom; height: number; snap: SplitSide | null; moved: boolean; folds: SplitFold[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [snap, setSnap] = useState<SplitSide | null>(null);
  const [percent, setPercent] = useState(50);

  const apply = (): void => {
    const box = shell.current;
    const line = ref.current;
    const found = parts(box, order);
    if (!box || !line || !found || drag.current?.moved) return;
    // A reorder can unmount the held divider before release; do not leave its section dimmed.
    // Only write when present, since these sections' class mutations call apply() again.
    for (const section of [found.top, found.bottom]) {
      if (section.classList.contains("will-fold")) section.classList.remove("will-fold");
    }
    const room = measure(found, line, order);
    const { min, max } = splitBounds(room);
    box.style.setProperty("--split-pcs-min", `${order === "pcs" ? min : room.room - max}px`);
    box.style.setProperty("--split-agents-min", `${order === "agents" ? min : room.room - max}px`);
    if (split === null) {
      box.classList.remove("has-split");
      box.style.removeProperty("--split-top");
    } else {
      box.classList.add("has-split");
      box.style.setProperty("--split-top", `${clampSplit(split, room)}px`);
    }
    setPercent(splitPercent(allocation(found, line), room.room));
  };
  useLayoutEffect(apply);
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => {
    const box = shell.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => latest.current());
    const folds = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => latest.current());
    observer.observe(box);
    const found = parts(box, order);
    for (const section of found ? [found.top, found.bottom] : []) {
      observer.observe(section);
      folds?.observe(section, { attributes: true, attributeFilter: ["class"] });
    }
    return () => { observer.disconnect(); folds?.disconnect(); };
  }, [shell, order]);

  const show = (height: number, room: number, next: SplitSide | null): void => {
    const box = shell.current;
    const found = parts(box, order);
    if (!box || !found) return;
    box.classList.add("has-split", "is-splitting");
    box.style.setProperty("--split-top", `${height}px`);
    setPercent(splitPercent(height, room));
    found.top.classList.toggle("will-fold", next === "top");
    found.bottom.classList.toggle("will-fold", next === "bottom");
  };
  const settle = (): void => {
    const found = parts(shell.current, order);
    shell.current?.classList.remove("is-splitting");
    found?.top.classList.remove("will-fold");
    found?.bottom.classList.remove("will-fold");
  };
  const fold = (side: SplitSide): void => onFold([sectionAt(side, order)]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || drag.current) return;
    const found = parts(shell.current, order);
    if (!found) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const room = measure(found, event.currentTarget, order);
    const startHeight = allocation(found, event.currentTarget);
    const folds = (["top", "bottom"] as const).filter((side) => found[side].classList.contains("is-collapsed")).map((side) => sectionAt(side, order));
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight, room, height: startHeight, snap: null, moved: false, folds };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dy = event.clientY - state.startY;
    if (!state.moved && Math.abs(dy) < 3) return;
    if (!state.moved) {
      state.moved = true;
      onFold([]);
    }
    const { snap, height, shown } = splitDrag(state.startHeight + dy, state.room);
    state.snap = snap;
    state.height = height;
    show(shown, state.room.room, snap);
    setSnap(state.snap);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setSnap(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    settle();
    if (!state.moved) return;
    if (event.type !== "pointerup") {
      // Cancellation (including lost capture) is not a release: undo the temporary opening and preview.
      onFold(state.folds);
      apply();
      return;
    }
    if (state.snap !== null) { fold(state.snap); apply(); return; }
    onSplit(state.height);
  };
  const reset = (): void => {
    onSplit(null);
    onFold([]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const found = parts(shell.current, order);
    if (!found) return;
    const room = measure(found, event.currentTarget, order);
    const action = keyedSplit(allocation(found, event.currentTarget), event.key, room);
    if (action === null) return;
    event.preventDefault();
    if ("reset" in action) reset();
    else if ("fold" in action) fold(action.fold);
    else { onFold([]); onSplit(action.split); }
  };

  return (
    <div
      ref={ref}
      className={`sidebar-split${dragging ? " is-dragging" : ""}${snap !== null ? " is-snapping" : ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={t("Resize PCs and Agents")}
      aria-controls={controls}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title={t("Drag to resize · double-click to reset")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    >
      <span className="sidebar-split-grip" aria-hidden="true" />
    </div>
  );
}
