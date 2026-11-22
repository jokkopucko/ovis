import type { ConversationResponse, ConversationTurn } from "../../shared/protocol.ts";
import { chatTurnAnchor } from "./chatScrollMemory.ts";

export interface ChatRowScope {
  readonly machineId: string;
  readonly paneId: string;
  readonly historyId: string | null;
  readonly incarnation: number;
}

export interface ChatRowSlot {
  readonly key: string;
}

export interface ChatRowSlots {
  readonly scope: ChatRowScope;
  readonly rows: readonly ChatRowSlot[];
  readonly nextSlot: number;
}

function slotRows(scope: ChatRowScope, firstSlot: number, count: number): readonly ChatRowSlot[] {
  return Array.from({ length: count }, (_, offset) => ({
    key: JSON.stringify([scope.machineId, scope.paneId, scope.historyId, scope.incarnation, firstSlot + offset]),
  }));
}

export function createChatRowSlots(scope: ChatRowScope, count: number): ChatRowSlots {
  return { scope, rows: slotRows(scope, 0, count), nextSlot: count };
}

export function insertChatRowSlots(slots: ChatRowSlots, index: number, count: number): ChatRowSlots {
  const rows = slotRows(slots.scope, slots.nextSlot, count);
  return {
    scope: slots.scope,
    rows: [...slots.rows.slice(0, index), ...rows, ...slots.rows.slice(index)],
    nextSlot: slots.nextSlot + count,
  };
}

export function prependChatRowSlots(slots: ChatRowSlots, count: number): ChatRowSlots {
  return insertChatRowSlots(slots, 0, count);
}

export function appendChatRowSlots(slots: ChatRowSlots, count: number): ChatRowSlots {
  return insertChatRowSlots(slots, slots.rows.length, count);
}

/**
 * Where turns were written between turns already shown, by their index in `after`: a notice or a
 * subagent's result Claude Code records while a turn is at work goes before that turn
 * (server/claude-transcript.ts noticeAt), and the turns after it must keep their rows.
 */
export function insertedTurns(before: readonly string[], after: readonly string[]): number[] {
  const inserted: number[] = [];
  let shown = 0;
  for (let index = 0; index < after.length && shown < before.length; index++) {
    if (after[index] === before[shown]) shown++;
    else if (after.indexOf(before[shown]!, index + 1) !== -1) inserted.push(index);
    else shown++;
  }
  return inserted;
}

function rowAnchor(turn: ConversationTurn): string {
  return turn.role === "assistant" && turn.ts !== null ? `assistant|${turn.ts}` : chatTurnAnchor(turn);
}

export function growChatRowSlots(slots: ChatRowSlots, start: number, shown: readonly ConversationTurn[], moved: readonly ConversationTurn[], newest: readonly ConversationTurn[]): ChatRowSlots {
  const now = [...moved, ...newest];
  const count = start + now.length;
  let grown = slots;
  for (const at of insertedTurns(shown.map(rowAnchor), now.map(rowAnchor))) {
    if (grown.rows.length < count) grown = insertChatRowSlots(grown, start + at, 1);
  }
  return grown.rows.length < count ? appendChatRowSlots(grown, count - grown.rows.length) : grown;
}

/**
 * Whether a gjc answer under a new history ID goes on with the turns shown. gjc writes its whole
 * session anew and renames it over the old file (its first save, trimmed tool outputs), so the server
 * names it as another history. When the newest page still opens with every turn shown, in the same
 * places (its role, its start time, each part's kind, and a tool's name, call id and input; a trim
 * may shorten what a tool answered), the rows keep their identity. Anything else starts the chat
 * over: a page that now starts elsewhere (a compaction that dropped turns), any other agent's new
 * ID, or a turn that changed otherwise (a new session, a cleared context, a rewind, a moved branch).
 */
export function continuesHistory(shown: Pick<ConversationResponse, "source" | "turns"> | null, next: Pick<ConversationResponse, "source" | "turns">): boolean {
  if (shown === null || shown.source !== "gjc-transcript" || next.source !== shown.source) return false;
  if (shown.turns.length === 0 || next.turns.length < shown.turns.length) return false;
  return shown.turns.every((turn, index) => {
    const after = next.turns[index]!;
    return turn.ts !== null && after.role === turn.role && after.ts === turn.ts && after.parts.length >= turn.parts.length
      && turn.parts.every((part, at) => {
        const other = after.parts[at]!;
        return other.kind === part.kind && (part.kind !== "tool" || (other.kind === "tool" && other.name === part.name
          && other.call_id === part.call_id && other.input === part.input));
      });
  });
}
