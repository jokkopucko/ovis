import type { Machine } from "../../shared/machines.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { composerMessage } from "./compose.ts";
import { paneLifetimes } from "./paneLifetime.ts";

/**
 * The user turns the chat held when a message was sent. Its own turn is written after the send, so
 * it is none of these. `latest` is the newest time of all the turns it held (the PC's clock) and
 * `takenAt` when the chat first read them (the browser's): their difference is never less than how
 * far the browser's clock runs ahead of the PC's, so it bounds the skew without trusting either clock.
 * `pcFloor` bounds the send itself more tightly, on the PC's clock alone: the PC's clock had passed
 * it when the send began, so the send's own turn is no older.
 */
export interface WaitingBaseline {
  keys: ReadonlySet<string>;
  latest: number | null;
  takenAt: number;
  /**
   * The PC's last answer to this chat's reads and what this browser's monotonic clock says has passed
   * since (observeWaitingClock), or the time the PC stamped on a send before typing it (stampedBaseline). null from
   * an older bridge, which says neither: the turns' times alone bound the skew.
   */
  pcFloor: number | null;
  /** made from a send's stamp alone, before the chat's first read: no turns shown to tell an older one of the stamp's second apart */
  unread?: true;
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
 * How far the two clocks may drift apart per millisecond after the PC answered: ten times a poor
 * quartz's hundred parts per million. A chat reads its pane every few seconds while it is open, but
 * a send can come long after a hidden tab's last read.
 */
const CLOCK_DRIFT = 0.001;

/** How far the wall clock may run ahead of the monotonic one, past drift, before the device is taken to have slept. A step of the wall clock past it counts the same, as the wall clock alone did before. */
const SLEEP_SLACK_MS = 2_000;

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
  if (after.latest !== null && at < after.latest) return false;
  // The PC's own clock bounds it more tightly than its newest turn, read perhaps long after it was
  // written, and needs neither of this browser's wall clock times: an identical turn another device
  // or the terminal wrote just before the send is not this one, whatever either wall clock did since
  if (after.pcFloor !== null) {
    if (at >= after.pcFloor) return true;
    // a whole-second turn may hold the floor in its second; one of an earlier second was written before it
    if (at + coarse <= after.pcFloor) return false;
    // stamped before the chat's first read, no turns were shown to rule out an older one of that
    // second: the same guard as a send with no turns shown above
    return after.unread !== true || last || answeredAt >= at + coarse;
  }
  return after.latest === null || at + coarse + (after.takenAt - after.latest) > send.at;
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
const shown = new Map<string, Omit<WaitingBaseline, "pcFloor">>();
/** each pane's last answered read: the PC's clock as it answered, and this browser's monotonic clock as it arrived */
const clocks = new Map<string, { pcTime: number; received: number; receivedWall: number }>();
const listedPanes = new Map<string, ReadonlySet<string>>();
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

/**
 * What the pane's chat holds now; take it before submitting, as `at` is. `now`: this browser's
 * monotonic clock (performance.now), which a wall clock step does not move; `wall` its wall clock.
 */
export function waitingBaseline(key: string, now = performance.now(), wall = Date.now()): WaitingBaseline | null {
  const turns = shown.get(key);
  if (turns === undefined) return null;
  const clock = clocks.get(key);
  if (clock === undefined) return { ...turns, pcFloor: null };
  const counted = Math.max(0, now - clock.received), walked = wall - clock.receivedWall;
  // Many browsers stop the monotonic clock while the device sleeps, though the PC's clock goes on: once
  // the wall clock went on further than the two can drift apart, it is the one that counted the sleep
  const passed = walked > counted + SLEEP_SLACK_MS + counted * CLOCK_DRIFT ? walked : counted;
  // the PC's clock went on at least as fast as this one, less what the two may drift apart
  return { ...turns, pcFloor: clock.pcTime + passed * (1 - CLOCK_DRIFT) };
}

/**
 * A read of the pane was answered (a 304 too): `serverTime` is the PC's clock as it answered
 * (ConversationResponse.server_time, or the `x-server-time` header), `received` this browser's
 * monotonic clock as the answer arrived and `receivedWall` its wall clock then. Each answer replaces
 * those that arrived before it: a PC whose clock was set back is bounded by its clock now, and an older
 * read whose body was parsed late does not bring its time back. Without a time (an older bridge) the
 * last one stays.
 */
export function observeWaitingClock(key: string, serverTime: string | null | undefined, received = performance.now(), receivedWall = Date.now()): void {
  const pcTime = serverTime == null ? Number.NaN : Date.parse(serverTime);
  if (Number.isFinite(pcTime) && !((clocks.get(key)?.received ?? Number.NEGATIVE_INFINITY) > received)) clocks.set(key, { pcTime, received, receivedWall });
}

/**
 * `after` bounded by the PC's own stamp of when it began typing the send (a queued row's
 * `sending_at`, or a submit-result's): its turn is written after it on the PC's clock alone, whatever
 * that clock or this browser's did since the chat's last read. A shown turn's time does not bound it
 * then: a clock set back since writes the send's turn before it. Without a stamp (an older bridge)
 * `after` stays as it is; `takenAt` (the browser's clock) dates a baseline made from the stamp alone.
 */
export function stampedBaseline(after: WaitingBaseline | null, sendingAt: string | undefined, takenAt = Date.now()): WaitingBaseline | null {
  const stamped = sendingAt === undefined ? Number.NaN : Date.parse(sendingAt);
  if (!Number.isFinite(stamped)) return after;
  if (after === null) return { keys: new Set(), latest: null, takenAt, pcFloor: stamped, unread: true };
  return { keys: after.keys, latest: null, takenAt: after.takenAt, pcFloor: stamped };
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
  clocks.delete(key);
  if (waiting.delete(key)) announce();
}

/** The chat dropped its transcript for another history: the turns it showed are no baseline for its next send. */
export function forgetWaitingBaseline(key: string): void {
  shown.delete(key);
}

/**
 * A connection loss drops provisional bubbles, but does not invalidate a chat's loaded turns. Only a
 * PC whose snapshots name their herdr keeps them: an older bridge's replacement would reuse its pane
 * ids unnoticed, so its baselines go with the connection.
 */
export function clearMachineWaitingSends(machineId: string): void {
  if (typeof paneLifetimes.generation(machineId) !== "string") { forgetMachineWaitingSends(machineId); return; }
  let changed = false;
  for (const key of waiting.keys()) {
    if (key.startsWith(`${machineId}:`)) { waiting.delete(key); changed = true; }
  }
  if (changed) announce();
}

// herdr gives pane ids out again once it is replaced (lib/paneLifetime.ts): the earlier herdr's
// sends never reach the new panes, so a PC's waiting lines go with its herdr
export function forgetMachineWaitingSends(machineId: string): void {
  listedPanes.delete(machineId);
  for (const key of [...waiting.keys(), ...shown.keys(), ...clocks.keys()]) if (key.startsWith(`${machineId}:`)) forgetWaitingSends(key);
}

export function pruneWaitingSends(machines: readonly Machine[]): void {
  for (const machine of machines) {
    if (machine.state !== "connected" || machine.snapshot === null) continue;
    // a roster read from a herdr this page already left (paneLifetimes skipped it) proves no pane closed
    const lifetime = machine.snapshot.herdr_lifetime;
    if (lifetime !== undefined && lifetime !== paneLifetimes.generation(machine.id)) continue;
    const open = new Set(machine.snapshot.panes.map((pane) => waitingKey(machine.id, pane.pane_id)));
    for (const key of listedPanes.get(machine.id) ?? []) {
      if (!open.has(key)) forgetWaitingSends(key);
    }
    listedPanes.set(machine.id, open);
  }
}

paneLifetimes.onRetire(forgetMachineWaitingSends);

export function subscribeWaitingSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
