import { join } from "node:path";
import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";

/** What the hub last saw of one agent: herdr's counter, the status, and when either last changed. */
interface Seen { seq?: number; status?: string; at?: number; told?: true }

const FILE = "agent-changes.json";
const SAVE_DELAY_MS = 2_000;
const MAX_ENTRIES = 2_000;

/**
 * When this server saw each agent's state change, by its own clock (HerdrPane.changed_at). Each PC's
 * herdr counts its changes from an origin of its own (state_change_seq), so only a time taken here
 * orders the agents of different PCs. Kept in the state directory, so a restart or a page reload
 * keeps the order; a change made while this server was away or the PC unreachable is dated when its
 * raised counter is first seen again. herdr's own counters and order are never changed.
 */
export class AgentChanges {
  private readonly seen = new Map<string, Seen>();
  private readonly path: string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `stateDir` null: nothing is read or written (tests, a server without a state directory). */
  constructor(stateDir: string | null, private readonly now: () => number = Date.now) {
    this.path = stateDir === null ? null : join(stateDir, FILE);
    if (this.path === null) return;
    try {
      const disk = readStateDocument(this.path);
      if (disk.kind !== "json" || typeof disk.value !== "object" || disk.value === null) return;
      for (const [key, value] of Object.entries(disk.value as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const { seq, status, at } = value as Record<string, unknown>;
        this.seen.set(key, {
          ...(typeof seq === "number" ? { seq } : {}), ...(typeof status === "string" ? { status } : {}), ...(typeof at === "number" ? { at } : {}),
        });
      }
    } catch (error) {
      // the order is a convenience: an unreadable file starts it empty, and the next write replaces it
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); the activity order starts empty`);
    }
  }

  /**
   * A status frame: its time when it changes the agent's status, else undefined. The counter that
   * comes with the next snapshot belongs to this change and is not dated again.
   */
  status(machineId: string, paneId: string, status: AgentStatus): number | undefined {
    const key = keyOf(machineId, paneId);
    const before = this.seen.get(key);
    if (before?.status === status) return undefined;
    // the first word of an agent is not a change: frames also repeat a status to carry a context or a plan
    if (!before) { this.seen.set(key, { status }); this.save(); return undefined; }
    const at = this.now();
    this.seen.set(key, { ...before, status, at, told: true });
    this.save();
    return at;
  }

  /**
   * A PC's snapshot with each agent's changed_at: a raised counter or another status than the one
   * last seen is a change now. An agent seen for the first time has no time, as nothing says when it
   * last changed; a lower counter is a new herdr run, which starts the agent over. Agents the
   * snapshot no longer has are forgotten.
   */
  snapshot(machineId: string, snapshot: SessionSnapshot): SessionSnapshot {
    // a partial roster (an older bridge's) says nothing of its agents: nothing is dated or forgotten
    if (!Array.isArray(snapshot.panes)) return snapshot;
    const seqs = new Map((snapshot.agents ?? []).map((agent) => [agent.pane_id, agent.state_change_seq] as const));
    let changed = false;
    const panes = snapshot.panes.map((pane) => {
      const key = keyOf(machineId, pane.pane_id);
      const seq = seqs.get(pane.pane_id);
      const status = pane.agent_status;
      const before = this.seen.get(key);
      let next: Seen;
      if (!before) next = { ...(seq === undefined ? {} : { seq }), status };
      else if (seq !== undefined && before.seq !== undefined && seq < before.seq) next = { seq, status };
      else {
        const raised = seq !== undefined && (before.seq === undefined || seq > before.seq);
        // a raised counter after a status frame is that frame's change, already dated
        const fresh = before.status !== status || raised && !before.told;
        next = { ...(seq === undefined ? {} : { seq }), status, ...(fresh ? { at: this.now() } : before.at === undefined ? {} : { at: before.at }) };
        if (before.told && !raised && before.status === status) next.told = true;
      }
      if (!sameSeen(before, next)) { this.seen.set(key, next); changed = true; }
      // a remote PC's own Ovis may name a time of its clock: only this server's is told
      const { changed_at: _theirs, ...own } = pane;
      return next.at === undefined ? own : { ...own, changed_at: next.at };
    });
    const open = new Set(snapshot.panes.map((pane) => keyOf(machineId, pane.pane_id)));
    const prefix = keyOf(machineId, "");
    for (const key of this.seen.keys()) if (key.startsWith(prefix) && !open.has(key)) { this.seen.delete(key); changed = true; }
    if (changed) this.save();
    return { ...snapshot, panes };
  }

  /** The PCs this server still has: the agents of a removed one are forgotten. */
  keepMachines(machineIds: readonly string[]): void {
    const kept = new Set(machineIds);
    let changed = false;
    for (const key of this.seen.keys()) if (!kept.has(key.slice(0, key.indexOf("\n")))) { this.seen.delete(key); changed = true; }
    if (changed) this.save();
  }

  /** Writes a pending change now (a stopping server). */
  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  private save(): void {
    if (this.path === null || this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; this.write(); }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  private write(): void {
    if (this.path === null) return;
    // the newest first, so a full table drops the agents that changed longest ago
    const entries = [...this.seen].sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_ENTRIES)
      .map(([key, { seq, status, at }]) => [key, { seq, status, at }] as const);
    try { writeStateDocument(this.path, JSON.stringify(Object.fromEntries(entries)), false); }
    catch (error) { console.error(`Cannot write ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
  }
}

const keyOf = (machineId: string, paneId: string): string => `${machineId}\n${paneId}`;
const sameSeen = (a: Seen | undefined, b: Seen): boolean =>
  a !== undefined && a.seq === b.seq && a.status === b.status && a.at === b.at && a.told === b.told;
