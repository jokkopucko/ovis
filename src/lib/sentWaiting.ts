import type { ConversationTurn } from "../../shared/protocol.ts";
import { composerMessage } from "./compose.ts";
import { paneLifetimes } from "./paneLifetime.ts";

/**
 * The user turns the chat held when a message was sent. Its own turn is written after the send, so
 * it is none of these. `latest` is the newest time of all the turns it held (the PC's clock) and
 * `takenAt` when the chat first read them (the browser's): their difference is never less than how
 * far the browser's clock runs ahead of the PC's, so it bounds the skew without trusting either clock.
 */
export interface WaitingBaseline {
  keys: ReadonlySet<string>;
  latest: number | null;
  takenAt: number;
}

/** One confirmed send, independent of any other sends to the same pane. */
export interface WaitingSend {
  id: number;
  pane: string;
  text: string;
  /** Captured before submitting, not when the receipt eventually arrives (the browser's clock). */
  at: number;
  /** what the chat held at send time; null when it had shown no turns, and `at` is the only guard */
  after: WaitingBaseline | null;
}

type Turn = Pick<ConversationTurn, "role" | "parts" | "ts">;

/**
 * A send whose turn has not come by then is no longer said to be on its way: Esc in the terminal,
 * an agent that rewrote it, or a turn with no time. The chat then shows what it shows without one.
 */
export const WAITING_SEND_MS = 60_000;

/**
 * How long a send may wait before its bubble gets a clock. An idle Claude writes the turn within half
 * a second of Send and a slow PC within a few seconds, so a clock sooner would flash on most sends;
 * past this something holds it (a turn still running, a PC far away), well before WAITING_SEND_MS.
 */
export const WAITING_HINT_MS = 5_000;

/**
 * Only what the terminal is known to do to a sent message: CRLF line ends, a space closing a final
 * @mention (server/core/composer.ts closeMention), whitespace at the ends of lines and around it.
 * Spaces inside a line stay: "change a b" and "change ab" are two messages.
 */
const said = (text: string): string => text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();

/** A command (`/cost`, a skill, `!` bash mode) comes back as a command, never as this user turn. */
const becomesTurn = (text: string): boolean => !/^\s*[/!]/u.test(text);

const turnTime = (turn: Turn): number => turn.ts === null ? Number.NaN : Date.parse(turn.ts);

/**
 * `answeredAt`: the newest time of the turns written after this one, NaN when none is dated.
 * `last`: it is the last of the turns read, nothing after it, dated or not.
 */
function newerThanSend(send: WaitingSend, at: number, key: string, answeredAt: number, last: boolean): boolean {
  const after = send.after;
  // the send's own turn is written after its `at`, which is taken before submitting; a transcript
  // that keeps whole seconds (Grok's) may record it up to a second early
  const coarse = at % 1000 === 0 ? 1000 : 0;
  if (after === null) {
    if (at >= send.at) return true;
    // Stamped in the send's own second, with no turns shown before the send to tell them apart: an
    // older message of that second reads the same. But an older one was answered before this send,
    // the agent being idle to take it: a turn follows it, all within that second. So it is this send's
    // when nothing at all was read after it, or once a turn after it was written in a later second.
    // Known limits, both needing the same words twice in one second before the chat's first read: an
    // older one whose answer the transcript never kept (stopped while thinking), or a read asked for
    // before the older one was answered, lets the bubble go a moment before its own turn shows
    return coarse > 0 && at + coarse > send.at && (last || answeredAt >= at + coarse);
  }
  if (after.keys.has(key)) return false;
  // written before the send, though the chat had not shown it yet: older than the send by any clock
  return after.latest === null || (at >= after.latest && at + coarse + (after.takenAt - after.latest) > send.at);
}

function turnMatches(send: WaitingSend, turn: Turn, key: string, answeredAt: number, last: boolean): boolean {
  const at = turnTime(turn);
  if (turn.role !== "user" || !Number.isFinite(at) || !newerThanSend(send, at, key, answeredAt, last)) return false;
  return said(turn.parts.filter((part) => part.kind === "text").map((part) => part.text).join(" ")) === said(send.text);
}

interface WaitingPane {
  sends: readonly WaitingSend[];
  /** A turn can acknowledge only one send, including across refreshes and tab unmounts. */
  claimed: Set<string>;
}
const waiting = new Map<string, WaitingPane>();
/** the user turns each pane's chat showed last, for the baseline of its next send */
const shown = new Map<string, WaitingBaseline>();
const empty: readonly WaitingSend[] = [];
const listeners = new Set<() => void>();
const announce = (): void => { for (const listener of listeners) listener(); };
let nextId = 0;

/** Two PCs may reuse a pane id. */
export const waitingKey = (machineId: string, paneId: string): string => `${machineId}:${paneId}`;

/** Each user turn's identity, the same turn twice told apart by its place: only a user turn can be a send's. */
function userTurns(turns: readonly Turn[]): { turn: Turn; key: string; answeredAt: number; last: boolean }[] {
  const occurrences = new Map<string, number>();
  const laterTimes = new Array<number>(turns.length);
  let newest = Number.NaN;
  for (let index = turns.length - 1; index >= 0; index--) {
    laterTimes[index] = newest;
    const time = turnTime(turns[index]!);
    if (Number.isFinite(time) && !(time <= newest)) newest = time;
  }
  return turns.flatMap((turn, index) => {
    if (turn.role !== "user") return [];
    const identity = JSON.stringify([turn.ts, turn.parts]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return [{ turn, key: `${identity}:${occurrence}`, answeredAt: laterTimes[index]!, last: index === turns.length - 1 }];
  });
}

/** What the pane's chat holds now; take it before submitting, as `at` is. */
export function waitingBaseline(key: string): WaitingBaseline | null {
  return shown.get(key) ?? null;
}

export function rememberWaitingSend(key: string, text: string, at = Date.now(), after: WaitingBaseline | null = null): void {
  // the text the composer types: paste markers it strips are no part of the turn
  const typed = composerMessage(text);
  if (typed.trim() === "" || !becomesTurn(typed)) return;
  const pane = waiting.get(key) ?? { sends: empty, claimed: new Set<string>() };
  const id = ++nextId;
  pane.sends = [...pane.sends, { id, pane: key, text: typed, at, after }];
  waiting.set(key, pane);
  setTimeout(() => expireWaitingSends(key), Math.max(0, at + WAITING_SEND_MS - Date.now()));
  announce();
}

/** Drop the sends whose turn has not come within WAITING_SEND_MS (the browser's clock on both sides). */
export function expireWaitingSends(key: string, now = Date.now()): void {
  const pane = waiting.get(key);
  if (!pane) return;
  const remaining = pane.sends.filter((send) => now - send.at < WAITING_SEND_MS);
  if (remaining.length === pane.sends.length) return;
  pane.sends = remaining;
  announce();
}

/** Stable snapshots for useSyncExternalStore, retained while another pane is active. */
export function currentWaitingSends(key: string): readonly WaitingSend[] {
  return waiting.get(key)?.sends ?? empty;
}

/**
 * Consume each transcript turn once, leaving every other send visible until its own turn exists.
 * `loaded`: the chat has read the pane's transcript, so no turns means an empty chat, not an unread one.
 */
export function settleWaitingSends(key: string, turns: readonly Turn[], now = Date.now(), loaded = turns.length > 0): void {
  const candidates = userTurns(turns);
  if (loaded) {
    // every shown turn was written before this read, the agent's too: the newest of them all bounds the skew
    const times = turns.map(turnTime).filter(Number.isFinite);
    const latest = times.length > 0 ? Math.max(...times) : null;
    const keys = new Set(candidates.map((candidate) => candidate.key));
    const before = shown.get(key);
    // the same turns settled again (the waiting list changed) are no new read: the first read's time stays
    const same = before !== undefined && before.latest === latest && before.keys.size === keys.size && [...keys].every((item) => before.keys.has(item));
    if (!same) shown.set(key, { keys, latest, takenAt: now });
  }
  const pane = waiting.get(key);
  if (!pane || pane.sends.length === 0) return;
  const remaining = pane.sends.filter((send) => {
    const match = candidates.find((candidate) => !pane.claimed.has(candidate.key) && turnMatches(send, candidate.turn, candidate.key, candidate.answeredAt, candidate.last));
    if (!match) return true;
    pane.claimed.add(match.key);
    return false;
  });
  if (remaining.length === pane.sends.length) return;
  pane.sends = remaining;
  announce();
}

/** Release a pane's waiting sends, consumed-turn identities and shown turns (a replaced herdr, tests). */
export function forgetWaitingSends(key: string): void {
  shown.delete(key);
  if (waiting.delete(key)) announce();
}

// herdr gives pane ids out again once it is replaced (lib/paneLifetime.ts): the earlier herdr's
// sends never reach the new panes, so a PC's waiting lines go with its herdr
export function forgetMachineWaitingSends(machineId: string): void {
  for (const key of [...waiting.keys(), ...shown.keys()]) if (key.startsWith(`${machineId}:`)) forgetWaitingSends(key);
}

paneLifetimes.onRetire(forgetMachineWaitingSends);

export function subscribeWaitingSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
