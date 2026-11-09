import type { AgentStatus } from "../shared/protocol.ts";

/** How long a turn's end is still held once its work ended: Claude goes on with the notice in about 2 s. */
export const WAIT_GRACE_MS = 60_000;
/**
 * The longest one rest is held. ponytail: nothing in a transcript tells a turn that waits on
 * its suite from one that left a dev server running, so a turn that only started a server is
 * held this long after its last rest before it reads DONE and alerts.
 */
export const WAIT_LIMIT_MS = 30 * 60_000;

interface Pane {
  statusSeen: boolean;
  busy: boolean;
  /** The last observed rest, independent of delayed prompt discovery: one at or after the prompt owns the budget. */
  restAt: number | null;
  promptAt: number | null;
  /** the running subagents and background commands its turn started (server/claude-subagents.ts) */
  turnRunning: number;
  /** when the last of them ended while the pane was at rest */
  endedAt: number | null;
  waiting: boolean;
  /** held at most WAIT_LIMIT_MS: false for an OmO pane, whose count drops what its dead host left */
  capped: boolean;
}

/**
 * A Claude Code turn that ended while work it started still runs in the background: a subagent,
 * or a command (a test suite, a build). herdr reads that pane as at rest, `done` while unseen,
 * and the work's notice will start the next turn by itself, with no prompt: the pane reads DONE
 * and alerts "work finished" while the work goes on. Live, herdr reads that next turn as
 * `working` about 2 s after the work ended.
 *
 * So a pane at rest whose turn's work runs, or ended less than WAIT_GRACE_MS ago, is waiting:
 * the sidebar says so in place of DONE, and the alerts take it for working (`alertStatus`,
 * shared/notify-policy.ts), so a turn that goes on is one turn, alerted once when it ends. Work
 * that ended before the turn did holds nothing. The limit starts again at each rest: a long run
 * of turns, each resumed by its CI run's, deploy's or suite's notice, reads DONE only once it
 * stops. A resting baseline starts no hold.
 *
 * An OmO pane is held the same way (index.ts `omoChanged`), on the count of its session's pending
 * and running tasks: OmO's records name the session, not the turn, that started a task. It is held
 * as long as one runs, with no WAIT_LIMIT_MS: a task whose host process died is not counted
 * (omo-status.ts), and OmO wakes the session when a task ends.
 */
export class BackgroundWait {
  private readonly panes = new Map<string, Pane>();

  constructor(private readonly now: () => number = Date.now, private readonly limits = { grace: WAIT_GRACE_MS, limit: WAIT_LIMIT_MS }) {}

  /** The pane's status as reported. True when that changed whether it waits. */
  status(paneId: string, status: AgentStatus): boolean {
    const pane = this.pane(paneId);
    pane.statusSeen = true;
    if (status === "working" || status === "blocked") {
      pane.busy = true;
      pane.endedAt = null;
    } else if (pane.busy) {
      // `done` and `idle` are one rest: a finish seen is not a new one
      pane.busy = false;
      pane.restAt = this.now();
    }
    return this.settle(pane);
  }

  /** A status read from a snapshot: only for a pane not known yet, as an event already seen is newer than any snapshot. */
  seed(paneId: string, status: AgentStatus): void {
    if (!this.panes.get(paneId)?.statusSeen) this.status(paneId, status);
  }

  /**
   * How many of the pane's running subagents and commands its turn started. True when that changed whether it waits.
   * `settled`: a count that fell did so with no work ending (a setting changed how it is read), so no grace follows.
   */
  running(paneId: string, turnRunning: number, promptAt: number | null = null, capped = true, settled = false): boolean {
    const pane = this.pane(paneId);
    pane.capped = capped;
    const newPrompt = promptAt !== null && promptAt !== pane.promptAt;
    if (newPrompt) {
      pane.promptAt = promptAt;
      pane.endedAt = null;
    }
    if (!newPrompt && turnRunning === 0 && pane.turnRunning > 0 && !pane.busy && !settled) pane.endedAt = this.now();
    pane.turnRunning = turnRunning;
    return this.settle(pane);
  }

  /** The panes whose wait ran out since last asked. */
  tick(): string[] {
    return [...this.panes].filter(([, pane]) => this.settle(pane)).map(([paneId]) => paneId);
  }

  waiting(paneId: string): boolean {
    return this.panes.get(paneId)?.waiting ?? false;
  }

  /** Drop lifetime-specific waits, not the latest observed pane status or its freshness guard. */
  reset(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.restAt = null;
    pane.promptAt = null;
    pane.turnRunning = 0;
    pane.endedAt = null;
    pane.waiting = false;
  }

  /**
   * reset, keeping the rest observed from `since` on: another agent's lifetime ended there, and the one that
   * followed was seen rest before its tracker knew its session. Its counts come afresh from that tracker.
   */
  resetBefore(paneId: string, since: number): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    const restAt = pane.restAt !== null && pane.restAt >= since ? pane.restAt : null;
    this.reset(paneId);
    pane.restAt = restAt;
  }

  forget(paneId: string): void {
    this.panes.delete(paneId);
  }

  private pane(paneId: string): Pane {
    let pane = this.panes.get(paneId);
    if (!pane) this.panes.set(paneId, pane = { statusSeen: false, busy: false, restAt: null, promptAt: null, turnRunning: 0, endedAt: null, waiting: false, capped: true });
    return pane;
  }

  private settle(pane: Pane): boolean {
    const now = this.now();
    const limit = pane.capped ? this.limits.limit : Infinity;
    const restAt = pane.restAt !== null && (pane.promptAt === null || pane.restAt >= pane.promptAt) ? pane.restAt : null;
    const waiting = !pane.busy && restAt !== null && now - restAt < limit
      && (pane.turnRunning > 0 || (pane.endedAt !== null && now - pane.endedAt < this.limits.grace));
    const changed = waiting !== pane.waiting;
    pane.waiting = waiting;
    return changed;
  }
}
