/**
 * How long each agent has been in its state (#3505). herdr reports no time of change, so this device
 * stamps a change when it sees one and keeps the stamps, per PC and pane, across reloads. Done and
 * idle are one state here: reading a finished agent turns done into idle, and looking is not the
 * agent doing anything. A state this device did not see begin has no stamp, and its row says no
 * time rather than a wrong one.
 *
 * A pane's ID is not the pane for good: herdr gives a pane it moves to another workspace a new ID,
 * and an ID may come to name another pane (the server reckons with an ended pane's ID being given
 * out again, server/finishes.ts). A pane's terminal is its own for as long as it lives, so a stamp
 * names the terminal of the pane it tells of, and tells of no other.
 *
 * A kept stamp is trusted by a look that did not see its state begin only on proof that the state
 * held meanwhile. Two counters give it together: herdr's `state_change_seq`, which moves with every
 * state of herdr's own, and the server's `finish_id`, which moves whenever the status Ovis shows
 * turns done. The state Ovis shows is not always herdr's (a Claude whose turn ended while a
 * subagent keeps herdr at working rests; server/core/status.ts), and every way back to a state
 * left that way passes a finish. For the agents whose state Ovis reads from their own session
 * files, herdr's counter stands still whatever they do, so nothing proves their stamps. The server
 * counts a pane's finishes by its ID (server/finishes.ts): a count is held against another only
 * where both were counted under the same ID. One thing no counter follows: the hold that a turn's
 * background work puts on a row at rest (`background_wait`, server/background-wait.ts). A hold
 * that began and ended wholly out of sight leaves a kept stamp of that rest standing.
 */
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { agentGroup, type AgentGroup } from "./agentRoster.ts";
import { BLIND_MS } from "./agentStateWatch.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { stateSeqs } from "./sidebarOrder.ts";
import { knownStatus } from "./status.ts";

export type StampState = Exclude<AgentGroup, "done">;

export function stampState(group: AgentGroup): StampState {
  return group === "done" ? "idle" : group;
}

export interface StateStamp {
  state: StampState;
  at: number;
  terminal: string;
  /**
   * herdr's `state_change_seq` of the change that began the state. Absent while only a pushed status told of the
   * change (the roster that carries its counter comes after), where the state changed and herdr's counter did not
   * (a status Ovis makes itself), and where herdr gives none: nothing proves such a stamp after a reload.
   */
  seq?: number;
  finish?: number;
  gone?: number;
}

/**
 * One PC's stamps, by pane, under the herdr they were made on (the snapshot's `herdr_lifetime`: another herdr gives
 * its pane ids to other panes) and the server's `finish_epoch` their `finish` counts in (a server that started anew
 * counts from nothing).
 */
export interface PcStamps { lifetime: string | null; epoch: string | null; rows: Readonly<Record<string, StateStamp>> }
export type StateStamps = Readonly<Record<string, PcStamps>>;

export interface SeenRow {
  pane: string;
  /** the pane's terminal (`terminal_id`): herdr gives a pane it moves to another workspace a new ID, and leaves it this */
  terminal: string;
  state: StampState;
  seq: number | undefined;
  finish: number | undefined;
  /**
   * The roster says done, whatever the row shows (a finish this device has read shows idle, lib/sidebarOrder.ts):
   * herdr's own turn from done moves its counter, and is no change of a state that reads the same before and after.
   */
  done: boolean;
  wait: boolean;
  /** an agent whose state Ovis reads from its own session files: herdr's counter says nothing of it */
  own: boolean;
}
export interface PcLook { id: string; lifetime: string | null; epoch: string | null; rows: readonly SeenRow[] | null }
export interface WatchedRow extends SeenRow {
  since: number;
  owed: boolean;
  left?: number;
}
export interface PcSeen { lifetime: string | null; epoch: string | null; at: number; first: number; rows: ReadonlyMap<string, WatchedRow>; displaced: ReadonlyMap<string, WatchedRow> }
export type LastLook = ReadonlyMap<string, PcSeen>;
export interface SeenStamps { stamps: StateStamps; last: LastLook }

/**
 * The agents whose state Ovis reads from their own session files in place of herdr's: the names the server's trackers
 * report under (server/omo-status.ts for OmO, and server/gjc-status.ts and server/letta-status.ts, built on it). herdr
 * goes on calling such a pane what it took it for, so its counter stands still while the agent works, waits and
 * rests.
 */
const OWN_STATE_AGENTS: ReadonlySet<string> = new Set(["omo", "gjc", "letta"]);

export function stateLooks(machines: readonly Machine[], status: (machineId: string, pane: SidebarAgent["pane"]) => AgentStatus | undefined): PcLook[] {
  return machines.map((machine): PcLook => {
    if (machine.state !== "connected" || machine.snapshot === null) return { id: machine.id, lifetime: null, epoch: null, rows: null };
    const seqs = stateSeqs(machine.snapshot);
    return {
      id: machine.id,
      lifetime: machine.snapshot.herdr_lifetime ?? null,
      epoch: machine.snapshot.finish_epoch ?? null,
      rows: sidebarAgents(machine.snapshot).map(({ pane }) => ({
        pane: pane.pane_id,
        terminal: pane.terminal_id,
        state: stampState(agentGroup(status(machine.id, pane))),
        seq: seqs.get(pane.pane_id),
        finish: pane.finish_id,
        done: knownStatus(pane.agent_status) === "done",
        wait: pane.background_wait === true,
        own: OWN_STATE_AGENTS.has(pane.agent ?? ""),
      })),
    };
  });
}

const KEPT_UNLISTED_MS = 30 * 86_400_000;

function unlisted(stamp: StateStamp, now: number, counted = true): StateStamp | null {
  const gone = Math.min(stamp.gone ?? now, now);
  if (now - gone > KEPT_UNLISTED_MS) return null;
  const left = gone === stamp.gone ? stamp : { ...stamp, gone };
  return counted ? left : uncounted(left);
}

function uncounted(stamp: StateStamp): StateStamp {
  if (stamp.finish === undefined) return stamp;
  const { finish: _other, ...rest } = stamp;
  return rest;
}

function proven(stamp: StateStamp | undefined, row: SeenRow, counted: boolean): stamp is StateStamp {
  return stamp !== undefined && stamp.state === row.state && !row.own
    && stamp.seq !== undefined && stamp.seq === row.seq
    && counted && stamp.finish !== undefined && stamp.finish === row.finish;
}

function ahead(stamp: StateStamp, row: SeenRow, counted: boolean): boolean {
  return (stamp.seq !== undefined && row.seq !== undefined && stamp.seq > row.seq)
    || (counted && stamp.finish !== undefined && row.finish !== undefined && stamp.finish > row.finish);
}

function keptStamp(stamp: StateStamp, now: number, counted: boolean): StateStamp {
  return { state: stamp.state, at: Math.min(stamp.at, now), terminal: stamp.terminal, ...(stamp.seq === undefined ? {} : { seq: stamp.seq }), ...(stamp.finish === undefined || !counted ? {} : { finish: stamp.finish }) };
}

function leftStamp(stamp: StateStamp, now: number, counted: boolean): StateStamp {
  const kept = keptStamp(stamp, now, counted);
  return stamp.gone === undefined ? kept : { ...kept, gone: Math.min(stamp.gone, now) };
}

/**
 * herdr gives a pane it moves to another workspace a new ID and leaves it its terminal (#1503), so a row whose
 * terminal the page saw under another ID is that pane; and so is one whose terminal the page saw before its ID went
 * to another pane, under whatever ID it is back.
 */
function movedRows(rows: readonly SeenRow[], watched: PcSeen | undefined): Map<string, WatchedRow> {
  const moved = new Map<string, WatchedRow>();
  if (watched === undefined) return moved;
  const listed = new Map<string, number>();
  for (const row of rows) listed.set(row.terminal, (listed.get(row.terminal) ?? 0) + 1);
  const remembered = new Map<string, WatchedRow | null>();
  for (const old of [...watched.rows.values(), ...watched.displaced.values()]) remembered.set(old.terminal, remembered.has(old.terminal) ? null : old);
  for (const row of rows) {
    const old = remembered.get(row.terminal);
    if (old !== undefined && old !== null && old !== watched.rows.get(row.pane) && listed.get(row.terminal) === 1) moved.set(row.pane, old);
  }
  return moved;
}

export function advanceStateStamps({ stamps, last }: SeenStamps, looks: readonly PcLook[], now: number, dated = true): SeenStamps {
  const next: Record<string, PcStamps> = {};
  const seen = new Map<string, PcSeen>();
  let changed = false;
  const looked = new Set(looks.map((look) => look.id));
  for (const look of looks) {
    const kept = stamps[look.id];
    if (look.rows === null) {
      if (kept !== undefined) next[look.id] = kept;
      continue;
    }
    // another herdr: its pane ids start over, so no stamp of the old one tells of a pane of this one, and no state
    // this page saw on the old one is a state this one's pane was in: its rows are first seen
    const sameHerdr = kept !== undefined && kept.lifetime === look.lifetime;
    const before = sameHerdr ? kept.rows : {};
    const counted = sameHerdr && look.epoch !== null && kept.epoch === look.epoch;
    const lastSeen = last.get(look.id);
    const watched = lastSeen !== undefined && lastSeen.lifetime === look.lifetime ? lastSeen : undefined;
    const recount = watched !== undefined && watched.epoch !== look.epoch;
    const rows: Record<string, StateStamp> = {};
    const memory = new Map<string, WatchedRow>();
    const moved = movedRows(look.rows, watched);
    for (const row of look.rows) {
      const from = moved.get(row.pane);
      const elsewhere = from !== undefined && from.pane !== row.pane;
      const own = (candidate: StateStamp | undefined): StateStamp | undefined => candidate !== undefined && candidate.terminal === row.terminal ? candidate : undefined;
      const here = own(before[row.pane]);
      const brought = elsewhere ? own(before[from.pane]) : undefined;
      const there = brought === undefined ? undefined : uncounted(brought);
      const stamp = !elsewhere || (here !== undefined && (ahead(here, row, counted) || (here.gone === undefined && proven(here, row, counted)))) ? here : there;
      const remembered = watched?.rows.get(row.pane);
      const known = from ?? (remembered !== undefined && remembered.terminal === row.terminal ? remembered : undefined);
      const saw = known !== undefined && known.left !== undefined && now - known.left > BLIND_MS ? undefined : known;
      const began = watched !== undefined && saw?.state !== row.state;
      const counter = saw !== undefined && saw.seq !== undefined && row.seq !== undefined && row.seq !== saw.seq;
      const lags = began && saw !== undefined && !counter;
      // two turns of herdr's own leave the state reading the same: from done (a finish read there, or the next turn its
      // background work started), and into the rest of a turn whose background work holds the row at working
      const undone = !began && saw !== undefined && saw.done && !row.done;
      const held = !began && saw !== undefined && row.wait && !saw.wait;
      memory.set(row.pane, { ...row, since: saw !== undefined && !began ? saw.since : now, owed: began ? lags : !counter && (undone || held || saw?.owed === true) });
      const finish = row.finish === undefined ? {} : { finish: row.finish };
      const seq = row.seq === undefined || lags ? {} : { seq: row.seq };
      if (stamp !== undefined && !lags && ahead(stamp, row, counted)) {
        rows[row.pane] = leftStamp(stamp, now, counted);
      } else if (watched === undefined) {
        if (proven(stamp, row, counted)) rows[row.pane] = keptStamp(stamp, now, counted);
      } else if (began) {
        const told = stamp !== undefined && stamp.gone === undefined && stamp.state === row.state && stamp.at >= (saw?.since ?? watched.at)
          && (lags || stamp.seq === undefined || row.seq === undefined || stamp.seq === row.seq);
        if (stamp !== undefined && told) rows[row.pane] = { state: stamp.state, at: Math.min(stamp.at, now), terminal: row.terminal, ...(lags && stamp.seq !== undefined ? { seq: stamp.seq } : seq), ...finish };
        else if (proven(stamp, row, counted)) rows[row.pane] = keptStamp(stamp, now, counted);
        else if (dated && (saw !== undefined || (known === undefined && stamp === undefined && now - watched.first > BLIND_MS))) rows[row.pane] = { state: row.state, at: now, terminal: row.terminal, ...seq, ...finish };
      } else if (stamp !== undefined && stamp.state !== row.state) {
        rows[row.pane] = leftStamp(stamp, now, counted);
      } else if (stamp !== undefined && saw !== undefined) {
        const recounted = recount || (elsewhere && saw.left === undefined);
        const finished = !recounted && saw.finish !== undefined && row.finish !== undefined && row.finish !== saw.finish && !(held && row.finish === saw.finish + 1);
        // herdr's counter counts every change of state in its session, so a move by one is a single turn of herdr's own,
        // and this pane's: it cannot have left a state that reads the same before and after it. Unless background work
        // held the row at working: that work's end shows the rest, and moves no counter
        const single = !saw.wait && saw.seq !== undefined && row.seq === saw.seq + 1;
        const stands = saw.left === undefined ? !counter || saw.owed || single : !row.own && saw.seq !== undefined && row.seq === saw.seq;
        if (!finished && stands) {
          const herdrs = counter ? row.seq : stamp.seq;
          rows[row.pane] = { state: stamp.state, at: Math.min(stamp.at, now), terminal: row.terminal, ...(herdrs === undefined ? {} : { seq: herdrs }), ...finish };
        }
      }
    }
    for (const [pane, stamp] of Object.entries(before)) {
      if (memory.has(pane) && (rows[pane] !== undefined || stamp.terminal === memory.get(pane)?.terminal)) continue;
      const left = unlisted(stamp, now, counted);
      if (left !== null) rows[pane] = left;
    }
    if (sameHerdr && kept.epoch === look.epoch && sameRows(kept.rows, rows)) next[look.id] = kept;
    else if (Object.keys(rows).length > 0) { next[look.id] = { lifetime: look.lifetime, epoch: look.epoch, rows }; changed = true; }
    else if (kept !== undefined) changed = true;
    const carried = new Set(moved.values());
    const displaced = new Map<string, WatchedRow>();
    if (watched !== undefined) for (const old of [...watched.rows.values(), ...watched.displaced.values()]) {
      const taken = memory.get(old.pane);
      if (carried.has(old) || taken?.terminal === old.terminal) continue;
      const left = old.left ?? now;
      if (now - left > KEPT_UNLISTED_MS) continue;
      const missed = old.left === undefined ? { ...old, left } : old;
      if (taken === undefined) memory.set(old.pane, missed);
      else displaced.set(old.terminal, missed);
    }
    seen.set(look.id, { lifetime: look.lifetime, epoch: look.epoch, at: now, first: watched?.first ?? now, rows: memory, displaced });
  }
  for (const [id, kept] of Object.entries(stamps)) {
    if (looked.has(id)) continue;
    const rows: Record<string, StateStamp> = {};
    for (const [pane, stamp] of Object.entries(kept.rows)) {
      const left = unlisted(stamp, now);
      if (left !== null) rows[pane] = left;
    }
    if (Object.keys(rows).length === 0) { changed = true; continue; }
    if (sameRows(kept.rows, rows)) next[id] = kept;
    else { next[id] = { lifetime: kept.lifetime, epoch: kept.epoch, rows }; changed = true; }
  }
  return { stamps: changed ? next : stamps, last: seen };
}

function sameRows(left: Readonly<Record<string, StateStamp>>, right: Readonly<Record<string, StateStamp>>): boolean {
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([pane, a]) => {
    const b = right[pane];
    return b !== undefined && a.state === b.state && a.at === b.at && a.terminal === b.terminal && a.seq === b.seq && a.finish === b.finish && a.gone === b.gone;
  });
}

export function stateSince(stamps: StateStamps, machineId: string, pane: string, terminal: string, state: StampState): number | null {
  const stamp = stamps[machineId]?.rows[pane];
  return stamp !== undefined && stamp.terminal === terminal && stamp.state === state ? stamp.at : null;
}

export const STATE_STAMPS_KEY = "ovis:agent-state-since";

const STAMP_STATES = ["blocked", "working", "idle"] as const satisfies readonly StampState[];
const isStampState = (value: unknown): value is StampState => STAMP_STATES.some((state) => state === value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fieldsOf = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

export function parseStateStamps(raw: string | null): StateStamps {
  if (raw === null) return {};
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { return {}; }
  const record = fieldsOf(stored);
  const pcs = record?.["version"] === 1 ? fieldsOf(record["pcs"]) : null;
  if (pcs === null) return {};
  const stamps: Record<string, PcStamps> = {};
  for (const [id, pc] of Object.entries(pcs)) {
    const rows = fieldsOf(fieldsOf(pc)?.["rows"]);
    if (rows === null) continue;
    const kept: Record<string, StateStamp> = {};
    for (const [pane, value] of Object.entries(rows)) {
      const { state, at, terminal, seq, finish, gone } = fieldsOf(value) ?? {};
      if (!isStampState(state) || !isNumber(at) || typeof terminal !== "string") continue;
      kept[pane] = { state, at, terminal, ...(isNumber(seq) ? { seq } : {}), ...(isNumber(finish) ? { finish } : {}), ...(isNumber(gone) ? { gone } : {}) };
    }
    const { lifetime, epoch } = fieldsOf(pc) ?? {};
    stamps[id] = { lifetime: typeof lifetime === "string" ? lifetime : null, epoch: typeof epoch === "string" ? epoch : null, rows: kept };
  }
  return stamps;
}

let lastRead: { text: string | null; stamps: StateStamps } | null = null;

export function loadStateStamps(): StateStamps | null {
  try {
    const text = window.localStorage.getItem(STATE_STAMPS_KEY);
    if (lastRead === null || lastRead.text !== text) lastRead = { text, stamps: parseStateStamps(text) };
    return lastRead.stamps;
  } catch {
    return null;
  }
}

export function saveStateStamps(stamps: StateStamps): boolean {
  try {
    const text = JSON.stringify({ version: 1, pcs: stamps });
    window.localStorage.setItem(STATE_STAMPS_KEY, text);
    lastRead = { text, stamps };
    return true;
  } catch {
    return false;
  }
}
