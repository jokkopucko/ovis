import { join } from "node:path";
import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";

/** What the hub last saw of one agent: herdr's counter, the status, and when either last changed. */
interface Seen { seq?: number; status: string; at?: number; told?: true }

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
  private stopped = false;

  /** `stateDir` null: nothing is read or written (tests, a server without a state directory). */
  constructor(stateDir: string | null, private readonly now: () => number = Date.now) {
    this.path = stateDir === null ? null : join(stateDir, FILE);
    if (this.path === null) return;
    try {
      const disk = readStateDocument(this.path);
      if (disk.kind !== "json" || typeof disk.value !== "object" || disk.value === null || Array.isArray(disk.value)) return;
      for (const [key, value] of Object.entries(disk.value as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const { seq, status, at, told } = value as Record<string, unknown>;
        if (typeof status !== "string") continue;
        this.seen.set(key, {
          status, ...(typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? { seq } : {}),
          ...(typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? { at } : {}),
          ...(told === true ? { told } : {}),
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
   * A PC's snapshot with each agent's changed_at. From a connected PC (`live`), a raised counter or
   * another status than the one last seen is a change now; an agent seen for the first time has no
   * time, as nothing says when it last changed; a lower counter is a new herdr run, which starts the
   * agent over; agents the snapshot no longer has are forgotten. A roster that is not live (one
   * cached in machines.json, a PC away) may be older than the times kept: it only shows them.
   */
  snapshot(machineId: string, snapshot: SessionSnapshot, live: boolean): SessionSnapshot {
    // a partial roster (an older bridge's) says nothing of its agents: nothing is dated or forgotten
    if (!Array.isArray(snapshot.panes)) return snapshot;
    const seqs = live ? new Map((snapshot.agents ?? []).map((agent) => [agent.pane_id, agent.state_change_seq] as const)) : undefined;
    let changed = false;
    let panesChanged = false;
    const panes = snapshot.panes.map((pane) => {
      const key = keyOf(machineId, pane.pane_id);
      const before = this.seen.get(key);
      let at = before?.at;
      if (seqs) {
        const next = this.observe(before, seqs.get(pane.pane_id), pane.agent_status);
        if (!sameSeen(before, next)) { this.seen.set(key, next); changed = true; }
        at = next.at;
      }
      // a remote PC's own Ovis may name a time of its clock: only this server's is told
      if (pane.changed_at === at) return pane;
      panesChanged = true;
      const { changed_at: _theirs, ...own } = pane;
      return at === undefined ? own : { ...own, changed_at: at };
    });
    if (live) {
      const open = new Set(snapshot.panes.map((pane) => keyOf(machineId, pane.pane_id)));
      const prefix = keyOf(machineId, "");
      for (const key of this.seen.keys()) if (key.startsWith(prefix) && !open.has(key)) { this.seen.delete(key); changed = true; }
    }
    if (changed) this.save();
    return panesChanged ? { ...snapshot, panes } : snapshot;
  }

  /** After losing the stream, a raised counter can include unseen changes, not just the last frame. */
  disconnected(machineId: string): void {
    const prefix = keyOf(machineId, "");
    let changed = false;
    for (const [key, seen] of this.seen) {
      if (!seen.told || !key.startsWith(prefix)) continue;
      const { told: _told, ...completed } = seen;
      this.seen.set(key, completed);
      changed = true;
    }
    if (changed) this.save();
  }

  /** A PC removed from this server: its agents' times go with it. */
  forget(machineId: string): void {
    const prefix = keyOf(machineId, "");
    let changed = false;
    for (const key of this.seen.keys()) if (key.startsWith(prefix)) { this.seen.delete(key); changed = true; }
    if (changed) this.save();
  }

  /** Writes a pending change now, and nothing after it (a stopping server). */
  flush(): void {
    this.stopped = true;
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  private observe(before: Seen | undefined, seq: number | undefined, status: string): Seen {
    if (!before) return { ...(seq === undefined ? {} : { seq }), status };
    if (seq !== undefined && before.seq !== undefined && seq < before.seq) return { seq, status };
    const raised = seq !== undefined && (before.seq === undefined || seq > before.seq);
    // a raised counter after a status frame is that frame's change, already dated; the first counter
    // of an agent first seen in a frame is where it starts, not a change
    const fresh = before.status !== status || before.seq !== undefined && raised && !before.told;
    // Older or partial snapshots can leave the counter out; only an observed value can replace it.
    const counter = seq ?? before.seq;
    const next: Seen = { ...(counter === undefined ? {} : { seq: counter }), status, ...(fresh ? { at: this.now() } : before.at === undefined ? {} : { at: before.at }) };
    // the frame's counter may come in a later snapshot than the next one
    if (before.told && !raised && before.status === status) next.told = true;
    return next;
  }

  private save(): void {
    if (this.path === null || this.timer !== null || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; this.write(); }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  private write(): void {
    if (this.path === null) return;
    // the newest first, so a full table drops the agents that changed longest ago
    const entries = [...this.seen].sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_ENTRIES)
      // `told` too: a restart between a frame and its counter must not date that change again
      .map(([key, { seq, status, at, told }]) => [key, { seq, status, at, told }] as const);
    try { writeStateDocument(this.path, JSON.stringify(Object.fromEntries(entries)), false); }
    catch (error) { console.error(`Cannot write ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
  }
}

const keyOf = (machineId: string, paneId: string): string => `${machineId}\n${paneId}`;
const sameSeen = (a: Seen | undefined, b: Seen): boolean =>
  a !== undefined && a.seq === b.seq && a.status === b.status && a.at === b.at && a.told === b.told;
