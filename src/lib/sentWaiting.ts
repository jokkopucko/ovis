import type { Machine } from "../../shared/machines.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { composerMessage } from "./compose.ts";
import { paneLifetimes } from "./paneLifetime.ts";

export interface WaitingBaseline {
  keys: ReadonlySet<string>;
  latest: number | null;
  takenAt: number;
  pcFloor: number | null;
  unread?: true;
}

export interface WaitingSend {
  id: number;
  pane: string;
  text: string;
  at: number;
  after: WaitingBaseline | null;
  unanswered?: true;
  seen?: ReadonlySet<string>;
  /** the herdr (its lifetime) an unanswered send was kept under: a herdr that replaced it gives the pane id to another pane */
  herdr?: string;
}

type Turn = Pick<ConversationTurn, "role" | "parts" | "ts">;

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

const becomesTurn = (text: string): boolean => !/^\s*[/!]/u.test(text);

const turnTime = (turn: Turn): number => turn.ts === null ? Number.NaN : Date.parse(turn.ts);

/**
 * How far the two clocks may drift apart per millisecond after the PC answered: ten times a poor
 * quartz's hundred parts per million.
 */
const CLOCK_DRIFT = 0.001;

const SLEEP_SLACK_MS = 2_000;

function newerThanSend(send: WaitingSend, at: number, key: string, answeredAt: number, last: boolean): boolean {
  const after = send.after;
  // the send's own turn is written after its `at`, which is taken before submitting; a transcript
  // that keeps whole seconds (Grok's) may record it up to a second early
  const coarse = at % 1000 === 0 ? 1000 : 0;
  if (after === null) {
    if (at >= send.at) return true;
    // Known limits, both needing the same words twice in one second before the chat's first read: an
    // older one whose answer the transcript never kept (stopped while thinking), or a read asked for
    // before the older one was answered, lets the bubble go a moment before its own turn shows
    return coarse > 0 && at + coarse > send.at && (last || answeredAt >= at + coarse);
  }
  if (after.keys.has(key)) return false;
  if (after.latest !== null && at < after.latest) return false;
  if (after.pcFloor !== null) {
    if (at >= after.pcFloor) return true;
    if (at + coarse <= after.pcFloor) return false;
    return after.unread !== true || last || answeredAt >= at + coarse;
  }
  return after.latest === null || at + coarse + (after.takenAt - after.latest) > send.at;
}

const turnSaid = (parts: Turn["parts"]): string => said(parts.filter((part) => part.kind === "text").map((part) => part.text).join(" "));

const keySaid = (key: string): string => turnSaid((JSON.parse(key.slice(0, key.lastIndexOf(":"))) as [Turn["ts"], Turn["parts"]])[1]);

function turnMatches(send: WaitingSend, turn: Turn, key: string, answeredAt: number, last: boolean): boolean {
  const at = turnTime(turn);
  if (turn.role !== "user" || !Number.isFinite(at) || !newerThanSend(send, at, key, answeredAt, last)) return false;
  return turnSaid(turn.parts) === said(send.text);
}

interface WaitingPane {
  sends: readonly WaitingSend[];
  claimed: Set<string>;
}
const waiting = new Map<string, WaitingPane>();
const shown = new Map<string, Omit<WaitingBaseline, "pcFloor">>();
const clocks = new Map<string, { pcTime: number; received: number; receivedWall: number }>();
const listedPanes = new Map<string, ReadonlySet<string>>();
const empty: readonly WaitingSend[] = [];
const listeners = new Set<() => void>();
const announce = (): void => { for (const listener of listeners) listener(); };
let nextId = 0;

/** Two PCs may reuse a pane id. */
export const waitingKey = (machineId: string, paneId: string): string => `${machineId}:${paneId}`;

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
  return { ...turns, pcFloor: clock.pcTime + passed * (1 - CLOCK_DRIFT) };
}

export function observeWaitingClock(key: string, serverTime: string | null | undefined, received = performance.now(), receivedWall = Date.now(), unchanged = false): void {
  if (unchanged) {
    reads.set(key, receivedWall);
    if (waiting.get(key)?.sends.length) queueMicrotask(() => markUnanswered(key));
  } else answered.set(key, receivedWall);
  const pcTime = serverTime == null ? Number.NaN : Date.parse(serverTime);
  if (Number.isFinite(pcTime) && !((clocks.get(key)?.received ?? Number.NEGATIVE_INFINITY) > received)) clocks.set(key, { pcTime, received, receivedWall });
}

export function stampedBaseline(after: WaitingBaseline | null, sendingAt: string | undefined, takenAt = Date.now()): WaitingBaseline | null {
  const stamped = sendingAt === undefined ? Number.NaN : Date.parse(sendingAt);
  if (!Number.isFinite(stamped)) return after;
  if (after === null) return { keys: new Set(), latest: null, takenAt, pcFloor: stamped, unread: true };
  return { keys: after.keys, latest: null, takenAt: after.takenAt, pcFloor: stamped };
}

export function rememberWaitingSend(key: string, text: string, at = Date.now(), after: WaitingBaseline | null = null): void {
  restore();
  const typed = composerMessage(text);
  if (typed.trim() === "" || !becomesTurn(typed)) return;
  const pane = waiting.get(key) ?? { sends: empty, claimed: new Set<string>() };
  const id = ++nextId;
  pane.sends = [...pane.sends, { id, pane: key, text: typed, at, after, seen: new Set(shown.get(key)?.keys ?? []) }];
  waiting.set(key, pane);
  announce();
}

export const WAITING_STUCK_MS = 10 * 60_000;

export function expireWaitingSends(key: string, now = Date.now()): void {
  const pane = waiting.get(key);
  if (!pane || rests.has(key)) return;
  const remaining = pane.sends.filter((send) => send.unanswered === true || now - send.at < WAITING_STUCK_MS);
  if (remaining.length === pane.sends.length) return;
  pane.sends = remaining;
  announce();
}

const rests = new Map<string, number>();
const reads = new Map<string, number>();
const answered = new Map<string, number>();

export function restingSince(key: string, at: number | null): void {
  if (at === null) rests.delete(key); else if (!rests.has(key)) rests.set(key, at);
}

/**
 * An agent that fails a
 * turn before it writes it (a sign-in lapsed, a model gone) shows why only in its terminal.
 */
export function markUnanswered(key: string, now = Date.now()): void {
  const pane = waiting.get(key);
  const rest = rests.get(key);
  const read = shown.get(key);
  if (!pane || rest === undefined || read === undefined || (reads.get(key) ?? -Infinity) <= rest) return;
  const due = (send: WaitingSend) => send.unanswered !== true && now - send.at >= WAITING_SEND_MS;
  if (!pane.sends.some(due)) return;
  const used = new Set<string>();
  const written = (send: WaitingSend): boolean => {
    const turn = [...read.keys].find((turn) => !used.has(turn) && !pane.claimed.has(turn) && !(send.seen ?? new Set()).has(turn));
    if (turn === undefined) return false;
    used.add(turn);
    return true;
  };
  const machine = key.slice(0, key.indexOf(":"));
  const lifetime = paneLifetimes.generation(machine);
  pane.sends = pane.sends.flatMap((send) => !due(send) ? [send] : written(send) ? []
    : [{ ...send, unanswered: true as const, ...(typeof lifetime === "string" ? { herdr: lifetime } : {}) }]);
  stored();
  announce();
}

export function dismissWaitingSend(key: string, id: number): void {
  const pane = waiting.get(key);
  if (!pane || !pane.sends.some((send) => send.id === id)) return;
  pane.sends = pane.sends.filter((send) => send.id !== id);
  stored();
  announce();
}

/** Where this tab keeps its unanswered sends across a reload: the user's own words, never sent again from it. */
const STORE_KEY = "ovis:unanswered-sends";
const UNANSWERED_KEEP_MS = 24 * 60 * 60 * 1000;
let restored = false;
function storage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}
function keptSend(key: string, send: WaitingSend, claimed: Iterable<string>) {
  const words = said(send.text);
  const own = (turn: string) => keySaid(turn) === words;
  const after = send.after === null ? null : { ...send.after, keys: [...send.after.keys].filter(own) };
  return { key, text: send.text, at: send.at, herdr: send.herdr, after, claimed: [...claimed].filter(own) };
}
function keptBaseline(value: unknown): WaitingBaseline | null {
  if (typeof value !== "object" || value === null) return null;
  const { keys, latest, takenAt, pcFloor, unread } = value as Record<string, unknown>;
  const time = (item: unknown): item is number | null => item === null || typeof item === "number";
  if (!Array.isArray(keys) || !keys.every((item) => typeof item === "string") || !time(latest) || typeof takenAt !== "number" || !time(pcFloor)) return null;
  return { keys: new Set(keys), latest, takenAt, pcFloor, ...(unread === true ? { unread } : {}) };
}
function stored(): void {
  const store = storage();
  if (store === null) return;
  const kept = [...waiting.entries()].flatMap(([key, pane]) => pane.sends.filter((send) => send.unanswered === true && send.herdr !== undefined).map((send) => keptSend(key, send, pane.claimed)))
    .concat([...restoredSends.entries()].flatMap(([key, sends]) => sends.map(({ send, claimed }) => keptSend(key, send, claimed))));
  try {
    if (kept.length === 0) store.removeItem(STORE_KEY); else store.setItem(STORE_KEY, JSON.stringify(kept));
  } catch { /* full or refused: kept in memory only */ }
}
function restore(now = Date.now()): void {
  if (restored) return;
  restored = true;
  let kept: unknown;
  try { kept = JSON.parse(storage()?.getItem(STORE_KEY) ?? "[]"); } catch { return; }
  if (!Array.isArray(kept)) return;
  for (const item of kept) {
    const { key, text, at, herdr, after, claimed } = (item ?? {}) as { key?: unknown; text?: unknown; at?: unknown; herdr?: unknown; after?: unknown; claimed?: unknown };
    if (typeof key !== "string" || typeof text !== "string" || typeof at !== "number" || typeof herdr !== "string" || !(now - at < UNANSWERED_KEEP_MS)) continue;
    const send: WaitingSend = { id: ++nextId, pane: key, text, at, after: keptBaseline(after), unanswered: true, herdr };
    const taken = Array.isArray(claimed) ? claimed.filter((turn): turn is string => typeof turn === "string") : [];
    restoredSends.set(key, [...(restoredSends.get(key) ?? []), { send, claimed: taken }]);
  }
}
const restoredSends = new Map<string, { send: WaitingSend; claimed: readonly string[] }[]>();
function adoptRestored(key: string): void {
  const sends = restoredSends.get(key);
  if (sends === undefined) return;
  const lifetime = paneLifetimes.generation(key.slice(0, key.indexOf(":")));
  if (typeof lifetime !== "string") return;
  restoredSends.delete(key);
  const same = sends.filter(({ send }) => send.herdr === lifetime);
  if (same.length > 0) {
    const pane = waiting.get(key) ?? { sends: empty, claimed: new Set<string>() };
    pane.sends = [...pane.sends, ...same.map(({ send }) => send)];
    for (const { claimed } of same) for (const turn of claimed) pane.claimed.add(turn);
    waiting.set(key, pane);
  }
  if (same.length !== sends.length) stored();
}

export function currentWaitingSends(key: string): readonly WaitingSend[] {
  restore();
  adoptRestored(key);
  return waiting.get(key)?.sends ?? empty;
}

export function settleWaitingSends(key: string, turns: readonly Turn[], now = Date.now(), loaded = turns.length > 0): void {
  const candidates = userTurns(turns);
  if (loaded) {
    const times = turns.map(turnTime).filter(Number.isFinite);
    const latest = times.length > 0 ? Math.max(...times) : null;
    const keys = new Set(candidates.map((candidate) => candidate.key));
    const before = shown.get(key);
    const same = before !== undefined && before.latest === latest && before.keys.size === keys.size && [...keys].every((item) => before.keys.has(item));
    if (!same) shown.set(key, { keys, latest, takenAt: now });
    const read = answered.get(key);
    if (read !== undefined) { answered.delete(key); reads.set(key, read); }
  }
  restore();
  const pane = waiting.get(key);
  if (!pane || pane.sends.length === 0) return;
  if (loaded) queueMicrotask(() => markUnanswered(key));
  const settled = new Set<WaitingSend>();
  const order = [...pane.sends.filter((send) => send.unanswered !== true), ...pane.sends.filter((send) => send.unanswered === true)];
  for (const send of order) {
    const match = candidates.find((candidate) => !pane.claimed.has(candidate.key) && turnMatches(send, candidate.turn, candidate.key, candidate.answeredAt, candidate.last));
    if (!match) continue;
    pane.claimed.add(match.key);
    settled.add(send);
  }
  if (settled.size === 0) return;
  pane.sends = pane.sends.filter((send) => !settled.has(send));
  stored();
  announce();
}

export function forgetWaitingSends(key: string): void {
  const held = restoredSends.delete(key);
  if (!releasePane(key) && !held) return;
  stored();
  announce();
}

function releasePane(key: string): boolean {
  shown.delete(key);
  clocks.delete(key);
  rests.delete(key);
  reads.delete(key);
  return waiting.delete(key);
}

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
  for (const [key, pane] of waiting) {
    if (!key.startsWith(`${machineId}:`)) continue;
    const kept = pane.sends.filter((send) => send.unanswered === true);
    if (kept.length === pane.sends.length) continue;
    changed = true;
    if (kept.length === 0) waiting.delete(key); else pane.sends = kept;
  }
  if (changed) announce();
}

// herdr gives pane ids out again once it is replaced (lib/paneLifetime.ts): the earlier herdr's
// sends never reach the new panes, so a PC's waiting lines go with its herdr
export function forgetMachineWaitingSends(machineId: string): void {
  listedPanes.delete(machineId);
  // the sends read back after a reload stay: they are shown under the herdr they were kept under alone, once the
  // page knows it (adoptRestored), whatever the connection did before
  let held = false;
  for (const key of [...waiting.keys(), ...shown.keys(), ...clocks.keys()]) if (key.startsWith(`${machineId}:`) && releasePane(key)) held = true;
  if (!held) return;
  stored();
  announce();
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
