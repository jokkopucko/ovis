/**
 * Nothing is stored past the page; a row that leaves the list leaves its summary behind.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { PANE_SUMMARY_DEADLINE_MS, PANE_SUMMARY_MAX_IDS, PANE_SUMMARY_PANE_MS } from "../../shared/pane-summary.ts";
import type { PaneSummaries, PaneSummary } from "../../shared/protocol.ts";
import { inboxKey, inboxStatus } from "./agentInbox.ts";
import type { AgentRow } from "./agentRoster.ts";
import { fetchPaneSummaries } from "./api.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

export const SUMMARY_ROWS = 60;
export const SUMMARY_RETRY_MS = 2000;
export const SUMMARY_RETRIES = 3;
const RETRY_BATCH = Math.min(PANE_SUMMARY_MAX_IDS, Math.max(1, Math.floor(PANE_SUMMARY_DEADLINE_MS / PANE_SUMMARY_PANE_MS)));

export interface RowSummary {
  role: "assistant" | "user";
  text: string;
  at: number | null;
  askedAt: number | null;
  failed: boolean;
}

export interface SummaryTarget { key: string; machineId: string; paneId: string; stamp: string; lifetime: string }

export function summaryTargets(rows: readonly AgentRow[], activity: SidebarActivity): SummaryTarget[] {
  return rows.filter((row) => row.machine.state === "connected").slice(0, SUMMARY_ROWS).map((row) => {
    const pane = row.entry.pane;
    const seq = activity.seqs(row.machine.id).get(pane.pane_id) ?? 0;
    const status = inboxStatus(row, activity);
    // a replaced herdr can reuse a pane id with the same finish, counter and state
    const lifetime = row.machine.snapshot?.herdr_lifetime ?? "";
    return { key: inboxKey(row), machineId: row.machine.id, paneId: pane.pane_id, stamp: `${lifetime}:${pane.finish_id ?? ""}:${seq}:${status ?? ""}`, lifetime };
  });
}

export type SummaryRead = (machineId: string, paneIds: readonly string[]) => Promise<PaneSummaries | null>;
export type SummaryWait = (run: () => void, ms: number) => () => void;

export const NO_SUMMARIES: ReadonlyMap<string, RowSummary> = new Map();
const readOf = (target: SummaryTarget): string => `${target.key}\n${target.stamp}`;

function timeOf(stamp: string | null, offset: number): number | null {
  if (stamp === null) return null;
  const ms = Date.parse(stamp) - offset;
  return Number.isNaN(new Date(ms).getTime()) ? null : ms;
}

const stampOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
/** An answer's summary as the wire types it: another PC's comes through the proxy unchecked. */
function wellFormed(value: unknown): value is PaneSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (summary.role === "assistant" || summary.role === "user") && typeof summary.text === "string"
    && stampOrNull(summary.at) && stampOrNull(summary.asked_at);
}

export class SummaryReads {
  private readonly listeners = new Set<() => void>();
  private current: ReadonlyMap<string, RowSummary> = NO_SUMMARIES;
  private targets = new Map<string, SummaryTarget>();
  private readonly started = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly waits = new Map<string, () => void>();
  private readonly queues = new Map<string, SummaryTarget[]>();
  private readonly busy = new Set<string>();
  private readonly missing = new Set<string>();
  private readonly answeredFor = new Map<string, string>();
  private readonly answeredIn = new Map<string, string>();
  private readonly rechecked = new Set<string>();
  private readonly replacing = new Set<string>();
  private readonly sources = new Map<string, string>();

  constructor(private readonly read: SummaryRead,
    private readonly wait: SummaryWait = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
    private readonly now: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  summaries = (): ReadonlyMap<string, RowSummary> => this.current;

  sync(targets: readonly SummaryTarget[]): void {
    const earlier = this.targets;
    this.targets = new Map(targets.map((target) => [target.key, target]));
    const live = new Set(targets.map(readOf));
    const machines = new Set(targets.map((target) => target.machineId));
    for (const machineId of [...this.missing]) if (!machines.has(machineId)) this.missing.delete(machineId);
    for (const read of [...this.started]) {
      if (live.has(read)) continue;
      this.started.delete(read);
      this.retries.delete(read);
      this.rechecked.delete(read);
      this.replacing.delete(read);
      this.waits.get(read)?.();
      this.waits.delete(read);
    }
    for (const [machineId, queue] of this.queues) this.queues.set(machineId, queue.filter((target) => this.isCurrent(target)));
    const gone = [...this.current.keys()].filter((key) => !this.targets.has(key));
    for (const key of [...this.answeredFor.keys()]) if (!this.targets.has(key)) this.answeredFor.delete(key);
    for (const key of [...this.answeredIn.keys()]) if (!this.targets.has(key)) this.answeredIn.delete(key);
    const replaced = [...this.current.keys()].filter((key) => {
      const was = this.answeredIn.get(key);
      const now = this.targets.get(key)?.lifetime;
      return Boolean(was) && Boolean(now) && was !== now;
    });
    if (replaced.length > 0) this.change((summaries) => { for (const key of replaced) { summaries.delete(key); this.sources.delete(key); } });
    for (const key of [...this.sources.keys()]) if (!this.targets.has(key)) this.sources.delete(key);
    const unfailed = [...this.current].filter(([key, row]) => row.failed && this.answeredFor.get(key) !== this.targets.get(key)?.stamp).map(([key]) => key);
    if (unfailed.length > 0) this.change((summaries) => { for (const key of unfailed) summaries.set(key, { ...summaries.get(key)!, failed: false }); });
    if (gone.length > 0) this.change((summaries) => { for (const key of gone) summaries.delete(key); });
    for (const target of targets) {
      const read = readOf(target);
      if (this.started.has(read) || this.missing.has(target.machineId)) continue;
      this.started.add(read);
      const before = earlier.get(target.key)?.stamp;
      if (before !== undefined && before !== target.stamp) this.replacing.add(read);
      this.enqueue(target);
    }
    for (const machineId of [...this.queues.keys()]) this.pump(machineId);
  }

  private isCurrent(target: SummaryTarget): boolean {
    const now = this.targets.get(target.key);
    return now?.stamp === target.stamp && now.machineId === target.machineId && now.paneId === target.paneId;
  }

  private enqueue(target: SummaryTarget): void {
    const queue = this.queues.get(target.machineId);
    if (queue) queue.push(target); else this.queues.set(target.machineId, [target]);
  }

  private change(edit: (summaries: Map<string, RowSummary>) => void): void {
    const next = new Map(this.current);
    edit(next);
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  private pump(machineId: string): void {
    if (this.busy.has(machineId) || this.missing.has(machineId)) return;
    const queue = (this.queues.get(machineId) ?? []).filter((target) => this.isCurrent(target));
    // Retry before the server's cached answer expires, without shortening unrelated first reads.
    const retries = queue.filter((target) => this.retries.has(readOf(target))).slice(0, RETRY_BATCH);
    const batch = retries.length === 0 ? queue.slice(0, PANE_SUMMARY_MAX_IDS) : retries;
    const sent = new Set(batch);
    this.queues.set(machineId, queue.filter((target) => !sent.has(target)));
    if (batch.length === 0) return;
    this.busy.add(machineId);
    const failed = () => {
      this.busy.delete(machineId);
      for (const target of batch) if (this.isCurrent(target)) this.again(target);
      this.pump(machineId);
    };
    this.read(machineId, batch.map((target) => target.paneId)).then((answer) => {
      try {
        if (answer === null) {
          this.missing.add(machineId);
          this.queues.delete(machineId);
        } else {
          this.take(batch, answer);
        }
      } catch {
        failed();
        return;
      }
      this.busy.delete(machineId);
      this.pump(machineId);
    }, failed);
  }

  private take(batch: readonly SummaryTarget[], answer: PaneSummaries): void {
    const serverNow = Date.parse(answer.server_time);
    const offset = Number.isNaN(serverNow) ? 0 : serverNow - this.now();
    const set = new Map<string, RowSummary>();
    const cleared: string[] = [];
    const left: SummaryTarget[] = [];
    for (const target of batch) {
      if (!this.isCurrent(target)) continue;
      if (!Object.hasOwn(answer.summaries, target.paneId)) { left.push(target); continue; }
      const summary: unknown = answer.summaries[target.paneId];
      this.answeredFor.set(target.key, target.stamp);
      this.answeredIn.set(target.key, target.lifetime);
      if (this.replacing.has(readOf(target))) this.recheck(target);
      if (!wellFormed(summary)) { if (this.current.has(target.key)) cleared.push(target.key); continue; }
      const row: RowSummary = { role: summary.role, text: summary.text, at: timeOf(summary.at, offset), askedAt: timeOf(summary.asked_at, offset), failed: summary.failed === true };
      const source = JSON.stringify([summary.role, summary.text, summary.at, summary.asked_at, row.failed]);
      const kept = this.current.get(target.key);
      const repeated = kept !== undefined && this.sources.get(target.key) === source;
      this.sources.set(target.key, source);
      if (!repeated || kept.failed !== row.failed) set.set(target.key, row);
    }
    for (const target of [...left.slice(1), ...left.slice(0, 1)]) this.again(target);
    if (set.size > 0 || cleared.length > 0) this.change((summaries) => {
      for (const key of cleared) summaries.delete(key);
      for (const [key, row] of set) summaries.set(key, row);
    });
  }

  private recheck(target: SummaryTarget): void {
    const read = readOf(target);
    if (this.rechecked.has(read)) return;
    this.rechecked.add(read);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(target)) return;
      this.enqueue(target);
      this.pump(target.machineId);
    }, SUMMARY_RETRY_MS));
  }

  private again(target: SummaryTarget): void {
    const read = readOf(target);
    const tried = this.retries.get(read) ?? 0;
    if (tried >= SUMMARY_RETRIES) {
      if (this.current.has(target.key) && this.answeredFor.get(target.key) !== target.stamp) this.change((summaries) => { summaries.delete(target.key); });
      return;
    }
    this.retries.set(read, tried + 1);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(target)) return;
      this.enqueue(target);
      this.pump(target.machineId);
    }, SUMMARY_RETRY_MS));
  }
}

export const newSummaryReads = (): SummaryReads => new SummaryReads(fetchPaneSummaries);

export function useInboxSummaries(reads: SummaryReads, targets: readonly SummaryTarget[]): ReadonlyMap<string, RowSummary> {
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const signature = targets.map((target) => `${target.key}:${target.machineId}:${target.paneId}:${target.stamp}`).join("\n");
  useEffect(() => { reads.sync(targetsRef.current); }, [reads, signature]);
  return useSyncExternalStore(reads.subscribe, reads.summaries, reads.summaries);
}
