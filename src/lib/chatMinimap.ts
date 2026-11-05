import type { ConversationTurn } from "../../shared/protocol.ts";

/** Fewer turns than this read at a glance: the minimap stays out. */
export const MINIMAP_MIN_TURNS = 4;
/** The empty margin beside the chat column the rail needs, so it never lies over the text. */
export const MINIMAP_GUTTER_PX = 32;

/** The closest two ticks may sit: past this a rail stands for several turns with one tick. */
export const MINIMAP_TICK_MIN_PX = 4;

export interface MinimapTurn {
  readonly row: number;
  readonly preview: string;
}

/** One tick per message the user sent; a compaction, a runtime notice or a task report is no turn of theirs. */
export function minimapTurns(turns: readonly ConversationTurn[]): MinimapTurn[] {
  const result: MinimapTurn[] = [];
  turns.forEach((turn, row) => {
    if (turn.role !== "user" || turn.parts.some((part) => part.kind === "compact" || part.kind === "notice" || part.kind === "task_result")) return;
    const text = turn.parts.map((part) => part.kind === "text" ? part.text : part.kind === "shell" ? `!${part.command}` : "").join(" ").replace(/\s+/g, " ").trim();
    result.push({ row, preview: text.length > 120 ? `${text.slice(0, 119)}…` : text });
  });
  return result;
}

export function minimapTop(index: number, count: number): number {
  return count <= 1 ? 0 : (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100;
}

/**
 * The tick of the turn in view: the first turn whose row is on screen, else the last one that
 * began above it (a long answer fills the view). Null before the first turn.
 */
export function minimapCurrent(turnRows: readonly number[], firstVisible: number, lastVisible: number): number | null {
  let before: number | null = null;
  for (const [index, row] of turnRows.entries()) {
    if (row >= firstVisible && row <= lastVisible) return index;
    if (row < firstVisible) before = index;
  }
  return before;
}

/**
 * How many ticks a rail this tall draws for `count` turns: one per turn while they sit
 * MINIMAP_TICK_MIN_PX apart, else one per slot of that size, so a long history loaded into the
 * chat adds no buttons once the rail is full. A rail too short for MINIMAP_MIN_TURNS ticks gets
 * fewer, never closer ones.
 */
export function minimapSlots(count: number, railPx: number): number {
  if (!(railPx > 0)) return count;
  return Math.min(count, Math.floor(railPx / MINIMAP_TICK_MIN_PX) + 1);
}

/** The first turn of a slot: turns are shared out evenly, the last slot ending at the last turn. */
export function minimapSlotTurn(slot: number, slots: number, count: number): number {
  return slots >= count ? slot : Math.floor((slot * count) / slots);
}

/** The turn a slot's tick jumps to: its first, except the last tick, which reaches the newest turn. */
export function minimapSlotTarget(slot: number, slots: number, count: number): number {
  return slot === slots - 1 ? count - 1 : minimapSlotTurn(slot, slots, count);
}

/** The slot a turn falls in. */
export function minimapTurnSlot(turn: number, slots: number, count: number): number {
  if (slots >= count) return turn;
  return Math.min(slots - 1, Math.floor(((turn + 1) * slots - 1) / count));
}

export function minimapFits(viewWidth: number, columnWidth: number): boolean {
  return (viewWidth - Math.min(viewWidth, columnWidth)) / 2 >= MINIMAP_GUTTER_PX;
}

export function minimapStep(from: number, count: number, key: string): number | null {
  if (count === 0) return null;
  if (key === "ArrowUp") return Math.max(0, from - 1);
  if (key === "ArrowDown") return Math.min(count - 1, from + 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
