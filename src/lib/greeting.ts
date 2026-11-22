import type { AgentStatus } from "../../shared/protocol.ts";

export interface BlankChat {
  loaded: boolean;
  failed: boolean;
  transcript: boolean;
  turns: number;
  older: boolean;
  /** turns a /tree left behind: they are listed where the conversation would start */
  abandoned: number;
  prompt: boolean;
  agent: string | null;
}

export function chatIsBlank(chat: BlankChat): boolean {
  return chat.loaded && !chat.failed && chat.transcript && chat.agent !== null
    && chat.turns === 0 && !chat.older && chat.abandoned === 0 && !chat.prompt;
}

export interface ChatRead {
  blank: boolean;
  turns: number;
  history: string | undefined;
}

export interface GreetingMemory {
  blank: boolean;
  history: string | null;
  sent: boolean;
  pending: number;
}

export const NO_MEMORY: GreetingMemory = { blank: false, history: null, sent: false, pending: 0 };

export function afterRead(memory: GreetingMemory, read: ChatRead | null): GreetingMemory {
  if (read === null) return memory.blank ? { ...memory, blank: false } : memory;
  const history = read.history ?? memory.history ?? "";
  const moved = memory.history !== null && memory.history !== history;
  const sent = memory.sent && read.turns === 0 && !moved;
  return memory.blank === read.blank && memory.history === history && memory.sent === sent ? memory : { ...memory, blank: read.blank, history, sent };
}

export function afterSend(memory: GreetingMemory): GreetingMemory {
  return { ...memory, pending: memory.pending + 1 };
}

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

export function roomOverComposer(stackHeight: number, composerHeight: number, lift: number, cardOffset: number): number {
  const room = stackHeight - composerHeight + lift + cardOffset;
  return room > 0 ? Math.round(room) : 0;
}
