import type { AgentStatus } from "../../shared/protocol.ts";
import { alertsAllow, shouldNotifyStatus, type AlertPrefs } from "../../shared/notify-policy.ts";
import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";

function machineOfKey(key: string): string {
  return key.startsWith("remote:") ? decodeURIComponent(key.slice(7, key.indexOf(":", 7))) : LOCAL_MACHINE;
}

export type DropletKind = "blocked" | "done" | "ended";

export interface DropletNotice {
  machineId: string;
  paneId: string;
  agent: string | null;
  title: string;
  machine: string | null;
  kind: DropletKind;
}

export interface QueuedDroplet extends DropletNotice {
  id: number;
}

export const LONG_TURN_MS = 60_000;
export const DROPLET_REPEAT_MS = 400;

export function dropletAllows(prefs: AlertPrefs, status: AgentStatus, worked: number | null, agentKind?: string | null): boolean {
  if (status === "blocked") return alertsAllow(prefs, status, agentKind);
  if (status !== "done" || prefs.done === "off") return false;
  if (prefs.done === "always") return true;
  return worked === null || worked >= LONG_TURN_MS;
}

/**
 * The server reads
 * the roster from herdr on its own, so a roster can show a change before the event that tells
 * of it arrives. A change that is news (shouldNotifyStatus) is therefore left to its event:
 * taken from the roster, the event would be no change and the alert would be lost.
 */
export function seedStatuses(
  known: Map<string, AgentStatus>,
  machines: readonly { id: string; snapshot?: { panes: readonly { pane_id: string; agent_status: AgentStatus }[] } | null }[],
  turns: { started: Map<string, number>; lasted: Map<string, number> } = { started: new Map(), lasted: new Map() },
  now = Date.now(),
): void {
  const listed = new Set<string>();
  // turns of a pane gone from a PC's roster go with it: a pane closed sends no pane-exited to clear them
  const read = new Set(machines.filter((machine) => machine.snapshot).map((machine) => machine.id));
  for (const machine of machines) for (const pane of machine.snapshot?.panes ?? []) {
    const key = paneStorageId(machine.id, pane.pane_id);
    listed.add(key);
    const previous = known.get(key);
    if (previous === pane.agent_status || shouldNotifyStatus(previous, pane.agent_status)) continue;
    known.set(key, pane.agent_status);
    const worked = trackTurn(turns.started, key, previous, pane.agent_status, now);
    if (worked !== null) turns.lasted.set(key, worked);
  }
  for (const key of [...known.keys()]) if (!listed.has(key)) known.delete(key);
  for (const map of [turns.started, turns.lasted]) {
    for (const key of [...map.keys()]) if (!listed.has(key) && read.has(machineOfKey(key))) map.delete(key);
  }
}

export function trackTurn(started: Map<string, number>, key: string, previous: AgentStatus | undefined, next: AgentStatus, now: number): number | null {
  const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
  if (busy(next)) {
    if (previous !== undefined && !busy(previous)) started.set(key, now);
    return null;
  }
  const since = started.get(key);
  started.delete(key);
  return since === undefined ? null : now - since;
}

export function endedTurn(started: Map<string, number>, lasted: Map<string, number>, key: string, now: number): number | null {
  const since = started.get(key);
  const last = lasted.get(key);
  started.delete(key);
  lasted.delete(key);
  if (since !== undefined) return now - since;
  return last ?? null;
}

export const FLICK_WINDOW_MS = 100;

export interface PressSample {
  y: number;
  t: number;
}

/**
 * The vertical speed at release (px per ms, up is negative), over the samples of the last
 * FLICK_WINDOW_MS only. Measured over the whole press, a hold before a flick reads as slow.
 */
export function flickVelocity(samples: readonly PressSample[], y: number, now: number): number {
  const from = samples.find((sample) => now - sample.t <= FLICK_WINDOW_MS);
  return from ? (y - from.y) / Math.max(1, now - from.t) : 0;
}

type Listener = (notice: QueuedDroplet) => void;
const listeners = new Set<Listener>();
let nextId = 1;
const lastShown = new Map<string, number>();

export function showDroplet(notice: DropletNotice, now = Date.now()): boolean {
  if (listeners.size === 0) return false;
  const key = `${notice.machineId}\n${notice.paneId}\n${notice.kind}`;
  const last = lastShown.get(key);
  if (last !== undefined && now - last < DROPLET_REPEAT_MS) return false;
  lastShown.set(key, now);
  const queued = { ...notice, id: nextId++ };
  for (const listener of listeners) listener(queued);
  return true;
}

export function onDroplet(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
