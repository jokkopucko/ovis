import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolPanes } from "../../shared/harness-tool.ts";
import { localPane, procLink, sameKey, type PaneKey, type PaneTerminal } from "./pane-proof.ts";
import { writePrivate, type RunStore } from "./runs.ts";

/**
 * The owner's word on each pane hc started that asked for the agent tool (docs/harness-tool.md): asked once per pane,
 * for as long as that pane's root process lives. A denial or a removal stands for that pane; turning the tool back to
 * look-only forgets every word, so turning it on again asks anew. An allowed pane has one run in RunStore.
 */
type State = "pending" | "allowed" | "denied";
interface Row { readonly id: string; readonly key: PaneKey; readonly label: string; readonly state: State; readonly run?: string }
const PENDING_MAX = 64;
const EMPTY: AgentToolPanes = { pending: [], allowed: [] };

function row(value: unknown): value is Row {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>, k = r.key as Record<string, unknown> | undefined;
  return typeof r.id === "string" && /^[a-f0-9]{16}$/.test(r.id) && typeof r.label === "string" && (r.state === "pending" || r.state === "allowed" || r.state === "denied")
    && (r.run === undefined || typeof r.run === "string") && !!k && typeof k.pane === "string" && typeof k.created_ms === "number" && typeof k.root === "number" && typeof k.birth === "string";
}

export class PaneGrants {
  private readonly rows = new Map<string, Row>();
  private readonly file: string;
  constructor(dir: string, private readonly runs: RunStore) {
    this.file = join(dir, "pane-grants.json");
    if (existsSync(this.file)) {
      try {
        const doc: unknown = JSON.parse(readFileSync(this.file, "utf8"));
        if (Array.isArray(doc) && doc.every(row)) for (const r of doc) if (r.state !== "allowed" || (r.run && runs.paneRun(r.run))) this.rows.set(r.id, r);
      } catch { console.warn("Agent tool: unreadable pane grants; every pane is asked again."); }
    }
    runs.keepPaneRuns(new Set([...this.rows.values()].flatMap(r => r.run ? [r.run] : [])));
  }
  private save(): void { writePrivate(this.file, JSON.stringify([...this.rows.values()])); paneFeed.tell(this); }
  private find(key: PaneKey): Row | undefined { return [...this.rows.values()].find(r => sameKey(r.key, key)); }
  /** What the owner said for this pane, asking him when nobody has: a card stays until he answers or the pane closes. */
  decide(key: PaneKey, label: string): { state: "pending" | "denied" | "full" } | { state: "allowed"; run: string } {
    const known = this.find(key);
    if (known) return known.state === "allowed" && known.run ? { state: "allowed", run: known.run } : { state: known.state === "allowed" ? "denied" : known.state };
    // a pane at this address that is not this one has closed: its word and run go with it
    for (const r of this.rows.values()) if (r.key.pane === key.pane) { if (r.run) this.runs.revoke(r.run); this.rows.delete(r.id); }
    if ([...this.rows.values()].filter(r => r.state === "pending").length >= PENDING_MAX) return { state: "full" };
    const id = randomBytes(8).toString("hex");
    this.rows.set(id, { id, key, label: label.slice(0, 80), state: "pending" });
    // a card that could not be written is not kept: the next call raises it again
    try { this.save(); } catch (error) { this.rows.delete(id); throw error; }
    return { state: "pending" };
  }
  /** Whether this pane's run is still the one its owner allowed. */
  allows(key: PaneKey, run: string): boolean {
    const r = this.find(key);
    return r?.state === "allowed" && r.run === run && this.runs.paneRun(run) !== null;
  }
  /** The owner's answer to one card, while it waits; the pane must still be the one that asked (`live`). */
  answer(id: string, allow: boolean, live: PaneTerminal | null): "ok" | "gone" {
    const r = this.rows.get(id);
    if (r?.state !== "pending") return "gone";
    if (!live || !localPane(live) || live.address !== r.key.pane || live.pid !== r.key.root || live.created_ms !== r.key.created_ms || procLink(r.key.root)?.birth !== r.key.birth) {
      this.rows.delete(id); this.save(); return "gone";
    }
    const run = allow ? this.runs.bindPane(r.key.pane).id : undefined;
    this.rows.set(id, { ...r, state: allow ? "allowed" : "denied", ...(run ? { run } : {}) });
    this.save();
    return "ok";
  }
  /** Takes an allowed pane back: its run ends, and it is not asked about again while it lives. */
  remove(id: string): boolean {
    const r = this.rows.get(id);
    if (r?.state !== "allowed") return false;
    if (r.run) this.runs.revoke(r.run);
    this.rows.set(id, { id: r.id, key: r.key, label: r.label, state: "denied" });
    this.save();
    return true;
  }
  /** The rows known now, so a list asked for later is held only against the rows that existed when it was asked. */
  known(): ReadonlySet<string> { return new Set(this.rows.keys()); }
  /**
   * Forgets the panes that closed or whose root process changed; `live` is hc's whole list of this PC's panes, asked for
   * when `before` was taken. A row made while the list was on its way may be a pane the list does not have yet: it stays.
   */
  reconcile(live: readonly PaneTerminal[], before: ReadonlySet<string>): void {
    const roots = live.filter(localPane);
    let changed = false;
    for (const r of this.rows.values()) {
      if (!before.has(r.id)) continue;
      if (roots.some(t => t.address === r.key.pane && t.pid === r.key.root && t.created_ms === r.key.created_ms)) continue;
      if (r.run) this.runs.revoke(r.run);
      this.rows.delete(r.id); changed = true;
    }
    if (changed) this.save();
  }
  forgetPane(pane: string): void {
    const gone = [...this.rows.values()].filter(r => r.key.pane === pane);
    if (gone.length === 0) return;
    for (const r of gone) { if (r.run) this.runs.revoke(r.run); this.rows.delete(r.id); }
    this.save();
  }
  /** Forgets every word at once, in memory first: a write that fails afterwards cannot leave one pane allowed. */
  clear(): void {
    if (this.rows.size === 0) return;
    const runs = [...this.rows.values()].flatMap(r => r.run ? [r.run] : []);
    this.rows.clear();
    try { for (const run of runs) this.runs.revoke(run); }
    finally { this.save(); }
  }
  view(): AgentToolPanes {
    const shown = (state: State) => [...this.rows.values()].filter(r => r.state === state).map(r => ({ id: r.id, pane: r.key.pane, label: r.label }));
    return { pending: shown("pending"), allowed: shown("allowed") };
  }
}

/** The grants of the hub that serves now, for the owner's screens; nothing while no hub serves. */
export const paneFeed = new class {
  private current: PaneGrants | null = null;
  private readonly listeners = new Set<(panes: AgentToolPanes) => void>();
  use(grants: PaneGrants | null): void { this.current = grants; this.tell(grants); }
  view(): AgentToolPanes { return this.current?.view() ?? EMPTY; }
  tell(from: PaneGrants | null): void { if (from === this.current) { const v = this.view(); for (const l of this.listeners) l(v); } }
  subscribe(listener: (panes: AgentToolPanes) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}();
