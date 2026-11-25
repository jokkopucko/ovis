import type { ConversationMetadata, HerdrPane, PaneContext, PlanStep, PlanSummary } from "../shared/protocol.ts";
import type { ServedStatus } from "./approvals/codex-status.ts";
import { rolloutThread } from "./codex.ts";
import { planSummary } from "../shared/plans.ts";
import { plain } from "./claude-subagents.ts";
import { PLAN_BUDGET, planState, readPlan, type PlanSource } from "./session-plan-reader.ts";
export { forgetPlans, readPlan, type PlanSource } from "./session-plan-reader.ts";

export { planSummary } from "../shared/plans.ts";

export interface SessionPlanDeps {
  claudePath: (paneId: string) => string | null;
  omoPath?: (paneId: string) => string | null;
  codexPath: (pane: HerdrPane) => Promise<string | null>;
  /** What the Codex server Ovis started in a pane says of its thread (approvals/codex.ts servedStatus). */
  codexServed?: (paneId: string) => ServedStatus | null;
  onChange: (paneId: string, summary: PlanSummary | null) => void;
  onContext?: (paneId: string, context: PaneContext | null) => void;
  claudeWindow?: (transcriptPath: string, model: string | null) => number | null;
  now?: () => number;
  retryMs?: number;
  relocateMs?: number;
  pollMs?: number;
}

interface Tracked {
  key: string;
  at: number;
  where: { source: PlanSource; path: string } | null;
  sig: string | null;
  summary: PlanSummary | null;
  metadata: ConversationMetadata | null;
  context: PaneContext | null;
}

export class SessionPlans {
  private readonly panes = new Map<string, Tracked>();
  private readonly wanted = new Map<string, string>();
  private refreshed = false;
  private readonly looking = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SessionPlanDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  summaryOf(paneId: string): PlanSummary | null {
    return this.panes.get(paneId)?.summary ?? null;
  }

  contextOf(paneId: string): PaneContext | null {
    return this.panes.get(paneId)?.context ?? null;
  }

  planOf(pane: HerdrPane | undefined): PlanStep[] | null {
    const where = pane !== undefined && this.known(pane) ? this.panes.get(pane.pane_id)?.where : null;
    return where ? readPlan(where.source, where.path, { left: 0 }) : null;
  }

  known(pane: HerdrPane): boolean {
    const tracked = this.panes.get(pane.pane_id);
    return tracked?.where != null && tracked.key === keyOf(pane);
  }

  async refresh(panes: HerdrPane[]): Promise<void> {
    this.wanted.clear();
    this.refreshed = true;
    for (const pane of panes) if (pane.agent === "claude" || pane.agent === "codex" || pane.agent === "omo") this.wanted.set(pane.pane_id, keyOf(pane));
    for (const [paneId, tracked] of this.panes) {
      if (this.wanted.has(paneId)) continue;
      this.panes.delete(paneId);
      if (tracked.summary !== null) this.deps.onChange(paneId, null);
      if (tracked.context !== null) this.deps.onContext?.(paneId, null);
    }
    await Promise.all(panes.map((pane) => this.ensure(pane)));
  }

  async ensure(pane: HerdrPane, asked = false): Promise<void> {
    if (pane.agent !== "claude" && pane.agent !== "codex" && pane.agent !== "omo") return;
    const key = keyOf(pane);
    if (pane.agent === "omo") {
      const path = this.deps.omoPath?.(pane.pane_id) ?? null;
      this.track(pane.pane_id, key, path === null ? null : { source: "omo-session", path });
      return;
    }
    if (pane.agent === "claude") {
      const path = this.deps.claudePath(pane.pane_id);
      this.track(pane.pane_id, key, path === null ? null : { source: "claude-transcript", path });
      return;
    }
    const tracked = this.panes.get(pane.pane_id);
    const due = !tracked || tracked.key !== key || this.now() - tracked.at >= (tracked.where === null ? this.deps.retryMs ?? 15_000 : this.deps.relocateMs ?? 30_000);
    if (!due || this.looking.has(pane.pane_id)) return;
    this.looking.add(pane.pane_id);
    try {
      const path = await this.deps.codexPath(pane).catch(() => null);
      if (!asked && this.refreshed && this.wanted.get(pane.pane_id) !== key) return;
      this.track(pane.pane_id, key, path === null ? null : { source: "codex-transcript", path });
    } finally {
      this.looking.delete(pane.pane_id);
    }
  }

  private track(paneId: string, key: string, where: { source: PlanSource; path: string } | null): void {
    const current = this.panes.get(paneId);
    const same = current !== undefined && current.where?.path === where?.path && current.where?.source === where?.source;
    const sameSession = same && current.key === key;
    this.panes.set(paneId, { key, at: this.now(), where, sig: sameSession ? current.sig : null, summary: current?.summary ?? null, metadata: sameSession ? current.metadata : null, context: current?.key === key ? current.context : null });
    if (current !== undefined && current.key !== key && current.context !== null) this.deps.onContext?.(paneId, null);
  }

  poll(): void {
    const budget = { left: PLAN_BUDGET };
    for (const [paneId, tracked] of this.panes) {
      if (tracked.where === null) {
        tracked.metadata = null;
        this.tellSummary(paneId, tracked, null);
      } else {
        const stat = plain(tracked.where.path);
        const sig = stat === null ? null : `${stat.id}:${stat.size}`;
        if (sig === null || sig !== tracked.sig) {
          const read = planState(tracked.where.source, tracked.where.path, budget);
          if (!read.behind) tracked.sig = sig;
          if (read.steps !== null || !read.behind) {
            tracked.metadata = read.metadata;
            this.tellSummary(paneId, tracked, planSummary(read.steps));
          }
        }
      }
      this.tellContext(paneId, tracked);
    }
  }

  private tellSummary(paneId: string, tracked: Tracked, summary: PlanSummary | null): void {
    if (JSON.stringify(summary) === JSON.stringify(tracked.summary)) return;
    tracked.summary = summary;
    this.deps.onChange(paneId, summary);
  }

  /** The Codex server of `paneId` said something new of its thread: its context is told at once. */
  servedChanged(paneId: string): void {
    const tracked = this.panes.get(paneId);
    if (tracked !== undefined) this.tellContext(paneId, tracked);
  }

  private tellContext(paneId: string, tracked: Tracked): void {
    const read = tracked.metadata?.context ?? null;
    const window = read !== null && tracked.where?.source === "claude-transcript" ? this.deps.claudeWindow?.(tracked.where.path, tracked.metadata?.model ?? null) ?? null : null;
    const context = this.servedContext(paneId, tracked) ?? (read === null ? null : window === null ? read : { ...read, window });
    if (JSON.stringify(context) === JSON.stringify(tracked.context)) return;
    tracked.context = context;
    this.deps.onContext?.(paneId, context);
  }

  /** The context the pane's Codex server said, while the rollout read is that thread's (its name carries the thread). */
  private servedContext(paneId: string, tracked: Tracked): PaneContext | null {
    if (tracked.where?.source !== "codex-transcript") return null;
    const served = this.deps.codexServed?.(paneId) ?? null;
    return served !== null && rolloutThread(tracked.where.path) === served.threadId.toLowerCase() ? served.context : null;
  }
}

const keyOf = (pane: HerdrPane): string => `${pane.agent}\0${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
