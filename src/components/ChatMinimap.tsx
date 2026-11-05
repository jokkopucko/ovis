import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";

import { minimapCurrent, minimapFits, minimapSlots, minimapSlotTarget, minimapStep, minimapTop, minimapTurnSlot, MINIMAP_MIN_TURNS, type MinimapTurn } from "../lib/chatMinimap.ts";
import { useT } from "../lib/i18n.ts";
import "./ChatMinimap.css";

export interface ChatMinimapProps {
  turns: readonly MinimapTurn[];
  /** the timeline's row keys in order, to tell which rows are on screen */
  rowKeys: readonly string[];
  scroller: RefObject<HTMLDivElement | null>;
  onJump: (row: number) => void;
  /** a wheel over the rail, which scrolls the chat from outside it: the chat counts it as the reader's input */
  onWheel?: (deltaY: number) => void;
}

const SPACING_PX = 8;
/** the room the rail leaves above and below it, as in its height below */
const MARGIN_REM = 12;

/**
 * A tick per turn the user sent, beside the chat column; the turn in view is marked. A rail too
 * short for every turn gives a tick to each run of turns, so loading older history adds no buttons.
 */
export function ChatMinimap({ turns, rowKeys, scroller, onJump, onWheel }: ChatMinimapProps) {
  const t = useT();
  const [current, setCurrent] = useState<number | null>(null);
  const [fits, setFits] = useState(false);
  const [railPx, setRailPx] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const ticks = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const positions = new Map(rowKeys.map((key, index) => [key, index]));
    const turnRows = turns.map((turn) => turn.row);
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const view = node.getBoundingClientRect();
      let first = Infinity, last = -1;
      for (const row of node.querySelectorAll<HTMLElement>("[data-chat-row]")) {
        const box = row.getBoundingClientRect();
        const index = positions.get(row.dataset.chatRow ?? "");
        if (index === undefined || box.bottom <= view.top || box.top >= view.bottom) continue;
        first = Math.min(first, index); last = Math.max(last, index);
      }
      const next = last < 0 ? null : minimapCurrent(turnRows, first, last);
      setCurrent((previous) => previous === next ? previous : next);
      const column = node.querySelector<HTMLElement>(".chat-transcript");
      const nextFits = column !== null && minimapFits(view.width, column.getBoundingClientRect().width);
      setFits((previous) => previous === nextFits ? previous : nextFits);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const nextRail = Math.max(0, Math.min((turns.length - 1) * SPACING_PX, view.height - MARGIN_REM * rem));
      setRailPx((previous) => previous === nextRail ? previous : nextRail);
    };
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
    schedule();
    node.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [scroller, rowKeys, turns]);

  // a rail with no height to stand on draws nothing, rather than a button per turn
  if (turns.length < MINIMAP_MIN_TURNS || !fits || railPx <= 0) return null;
  const count = turns.length;
  const slots = minimapSlots(count, railPx);
  // a rail too short to keep MINIMAP_MIN_TURNS ticks apart draws nothing, as too few turns do
  if (slots < MINIMAP_MIN_TURNS) return null;
  const currentSlot = current === null ? null : minimapTurnSlot(current, slots, count);
  const stop = Math.min(focusIndex ?? currentSlot ?? slots - 1, slots - 1);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const next = minimapStep(stop, slots, event.key);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    ticks.current[next]?.focus();
  };
  return <nav
    className="chat-minimap"
    aria-label={t("Conversation turns")}
    style={{ height: `min(${(count - 1) * SPACING_PX}px, calc(100% - ${MARGIN_REM}rem))`, "--minimap-steps": slots - 1 } as CSSProperties}
    onKeyDown={onKeyDown}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusIndex(null); }}
    onWheel={(event) => { onWheel?.(event.deltaY); scroller.current?.scrollBy({ top: event.deltaY }); }}
  >
    {Array.from({ length: slots }, (_, index) => {
      const turnIndex = minimapSlotTarget(index, slots, count);
      const turn = turns[turnIndex]!;
      return <button
        key={turn.row}
        ref={(element) => { ticks.current[index] = element; }}
        type="button"
        className="chat-minimap-tick"
        style={{ top: `${minimapTop(index, slots)}%` }}
        tabIndex={index === stop ? 0 : -1}
        aria-label={t("Go to turn {n}", { n: turnIndex + 1 })}
        aria-current={index === currentSlot ? "true" : undefined}
        title={turn.preview || undefined}
        onFocus={() => setFocusIndex(index)}
        onClick={() => onJump(turn.row)}
      />;
    })}
  </nav>;
}
