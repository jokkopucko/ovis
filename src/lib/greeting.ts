import type { AgentStatus } from "../../shared/protocol.ts";

/**
 * The greeting of an empty chat: one line over the composer, "What should {agent} do in
 * {folder}?". It is offered only where the conversation is known to hold nothing yet, never
 * where it could not be read, is still loading, or belongs to no agent.
 */

export interface BlankChat {
  /** the first read has answered */
  loaded: boolean;
  /** the last read failed */
  failed: boolean;
  /** the agent's own transcript, not the terminal's scrollback in its place */
  transcript: boolean;
  /** turns on the page and the pages above it */
  turns: number;
  /** pages above the newest were not read yet: the conversation holds more than this page shows */
  older: boolean;
  /** turns a /tree left behind: they are listed where the conversation would start */
  abandoned: number;
  /** a question, approval or menu waits in the chat */
  prompt: boolean;
  agent: string | null;
}

/** A conversation read in full that holds nothing: the only chat a greeting may stand in. */
export function chatIsBlank(chat: BlankChat): boolean {
  return chat.loaded && !chat.failed && chat.transcript && chat.agent !== null
    && chat.turns === 0 && !chat.older && chat.abandoned === 0 && !chat.prompt;
}

/** What one answered read of a pane's conversation says; null where nothing is known (loading, a failed read, the chat not shown). */
export interface ChatRead {
  blank: boolean;
  /** turns it holds, the ones a /tree left behind included */
  turns: number;
  history: string | undefined;
}

/** What is remembered of a pane's chat between its reads, whether the chat is shown or not. */
export interface GreetingMemory {
  /** the last read found the conversation blank */
  blank: boolean;
  /** the history the last answered read was of; null before any */
  history: string | null;
  /** a message was typed into the pane, or may have been, and the conversation has shown neither a turn nor a new history since */
  sent: boolean;
  /** messages on their way that the server has not answered for yet */
  pending: number;
}

export const NO_MEMORY: GreetingMemory = { blank: false, history: null, sent: false, pending: 0 };

/**
 * A read came in. Nothing known (the chat is loading, its read failed, or it left the screen) is
 * not blank, and it forgets no message: only a turn or another history ends what a send began.
 * A read that names no history (the scrollback standing in) is of the one already held.
 * Messages on their way are not a read's to count: their own answers settle them.
 */
export function afterRead(memory: GreetingMemory, read: ChatRead | null): GreetingMemory {
  if (read === null) return memory.blank ? { ...memory, blank: false } : memory;
  const history = read.history ?? memory.history ?? "";
  const moved = memory.history !== null && memory.history !== history;
  const sent = memory.sent && read.turns === 0 && !moved;
  return memory.blank === read.blank && memory.history === history && memory.sent === sent ? memory : { ...memory, blank: read.blank, history, sent };
}

/** A message left the composer, read or not yet: the server has not answered for it. */
export function afterSend(memory: GreetingMemory): GreetingMemory {
  return { ...memory, pending: memory.pending + 1 };
}

/**
 * The server answered for one message. `typed` is whether any of it reached the pane, or may
 * have; a message refused before that leaves nothing behind. `history` is the one held when it
 * left (null before any read): a message typed into a conversation since replaced (a /clear
 * read before its answer came) is not one the new conversation waits to show.
 * Each message settles only its own count, so two on their way never undo each other.
 */
export function afterSettled(memory: GreetingMemory, typed: boolean, history: string | null): GreetingMemory {
  const pending = memory.pending > 0 ? memory.pending - 1 : 0;
  const sent = memory.sent || (typed && (history === null || memory.history === history));
  return memory.pending === pending && memory.sent === sent ? memory : { ...memory, sent, pending };
}

// Held outside any component: PaneTerminal is mounted again for each PC (App.tsx), and a look at
// another PC's pane must not bring the greeting back. Keyed by paneStorageId(machineId, paneId).
const remembered = new Map<string, GreetingMemory>();

export function greetingMemory(owner: string): GreetingMemory {
  return remembered.get(owner) ?? NO_MEMORY;
}

export function rememberGreeting(owner: string, memory: GreetingMemory): void {
  if (memory === NO_MEMORY) remembered.delete(owner);
  else remembered.set(owner, memory);
}

export interface GreetingState {
  memory: GreetingMemory;
  agentStatus: AgentStatus | undefined;
  /** messages held for this pane: their list sits where the greeting would */
  queued: number;
  folder: string;
}

/**
 * Whether the greeting shows. A message sent takes it away at once, before the server answers
 * for it and before the transcript holds the turn; an agent asking is not asked what it should do.
 * A status at work alone leaves it: a /clear reports one for a moment with no turn (#2550), and a
 * turn begun elsewhere ends it once a read holds that turn.
 */
export function showsGreeting(state: GreetingState): boolean {
  return state.memory.blank && !state.memory.sent && state.memory.pending === 0
    && state.agentStatus !== "blocked"
    && state.queued === 0 && state.folder !== "";
}

/**
 * The folder a path ends in: its last segment, the root itself for a root, "" for no path.
 * A backslash separates only in a Windows path (a drive letter or UNC): elsewhere it is a
 * character of the name.
 */
export function greetingFolder(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const separator = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(cwd) ? /[\\/]+/u : /\/+/u;
  const trimmed = cwd.replace(new RegExp(`(?:${separator.source})$`, "u"), "");
  if (trimmed === "") return cwd.charAt(0);
  const parts = trimmed.split(separator);
  return parts[parts.length - 1] ?? "";
}

/**
 * How far (px, zero or negative) the docked composer moves up so that it and the greeting above
 * it sit at the vertical centre of the stack. Zero when the stack is too short to hold both.
 */
export function composerLift(stackHeight: number, composerHeight: number, greetingHeight: number): number {
  const spare = stackHeight - composerHeight - greetingHeight;
  if (!(spare > 0)) return 0;
  return 0 - Math.round(spare / 2);
}

/**
 * Whether the stack holds the composer and the greeting above it. Where it does not (a phone on
 * its side with the keyboard up), the greeting would run out of the pane's top: it stays out.
 */
export function greetingFits(stackHeight: number, composerHeight: number, greetingHeight: number): boolean {
  return stackHeight - composerHeight - greetingHeight >= 0;
}

/**
 * The room (px) over the input card of a lifted composer, where its completion menu opens:
 * from the stack's top to the card's top. `cardOffset` is the card's top within the composer.
 */
export function roomOverComposer(stackHeight: number, composerHeight: number, lift: number, cardOffset: number): number {
  const room = stackHeight - composerHeight + lift + cardOffset;
  return room > 0 ? Math.round(room) : 0;
}
