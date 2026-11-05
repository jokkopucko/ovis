import type { ConversationTurn } from "../../shared/protocol.ts";

/**
 * Where a reader left one pane's chat: the turn at the top of the view and how far below the
 * view's top edge it started, or `atEnd` while the reader followed the end. Kept in memory only,
 * one entry per `paneStorageId(machineId, paneId)`, for the page's lifetime.
 */
export interface ChatPosition {
  readonly historyId: string | null;
  readonly turn: string;
  /** the turn's top minus the view's top, in CSS pixels (negative: it started above the view) */
  readonly offset: number;
  readonly atEnd: boolean;
}

const LIMIT = 100;
const positions = new Map<string, ChatPosition>();

/**
 * A turn's identity that survives a remount: row keys are browser slots that a new mount
 * allocates again, so the turn is named by what it is: its role, its time and how its first part
 * begins. Only the beginning counts: a turn still streaming keeps the name it had.
 */
export function chatTurnAnchor(turn: ConversationTurn): string {
  const first = turn.parts[0];
  const head = first === undefined ? "" : "text" in first ? first.text.slice(0, 80) : JSON.stringify(first).slice(0, 80);
  return `${turn.role}|${turn.ts ?? ""}|${first?.kind ?? ""}|${head}`;
}

export function rememberChatPosition(storageId: string, position: ChatPosition): void {
  positions.delete(storageId);
  positions.set(storageId, position);
  if (positions.size > LIMIT) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

export function readChatPosition(storageId: string): ChatPosition | undefined {
  return positions.get(storageId);
}

/** herdr moved the pane under a new ID (#1503): its chat reads on where the reader left it; a place the new ID has stays. */
export function moveChatPosition(from: string, to: string): void {
  const left = positions.get(from);
  if (left === undefined || from === to) return;
  positions.delete(from);
  if (!positions.has(to)) rememberChatPosition(to, left);
}

export function forgetChatPositions(): void {
  positions.clear();
}

/**
 * The row to put back at the top of the view, or null to land at the end: the reader followed
 * the end, the conversation was replaced since (another history), or the turn is not among the
 * rows loaded now (an earlier page the new mount has not read).
 */
export function chatRestoreIndex(position: ChatPosition | undefined, historyId: string | null, anchors: readonly string[]): number | null {
  if (position === undefined || position.atEnd || position.historyId !== historyId) return null;
  const index = anchors.indexOf(position.turn);
  return index < 0 ? null : index;
}
