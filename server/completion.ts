import { readFileSync, statSync } from "node:fs";

import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import { herdrSocketPath } from "./herdr/client.ts";
import { isNamedPipe, pipeIdentity } from "./herdr-core/pipe.ts";
import { writeStateDocument } from "./state-document.ts";

/**
 * herdr reports `done` for an agent that went back to idle while its pane was not being
 * looked at (not focused), and `idle` once it is. It follows the agent it saw working, so
 * an agent recognised from its screen and processes rather than an integration can
 * finish as plain `idle`: an omo pane reads `pi/working`, then `claude/unknown` while
 * omo's claude child runs, then `claude/idle` (live-traced with omo 5.0), and the
 * working agent herdr knew never finished. The sidebar said READY, and no alert came.
 *
 * herdr's focus is also no sign that anyone saw a finish. It is the pane its terminal
 * last had in front, and it stays there while the user works from a browser or a phone,
 * which never move it: an agent finishing in that pane finished as plain `idle`, READY
 * and no alert, whoever was looking.
 *
 * And the `unknown` in between, while another agent is there, is reported as `working`
 * (omo's whole turn read `claude/unknown` after `pi/working`, and the sidebar showed no RUN).
 *
 * The agent that worked reading `unknown` itself is a finish, not more work: Codex, which
 * herdr follows through its integration, reads `codex/working` for a turn and then
 * `codex/unknown` at rest (live, herdr 0.9.3). Reported as working, every Codex pane that
 * ever worked read RUN for good, and no done alert came.
 *
 * herdr keeps its own `done` across a restart of this server; what is kept here was lost
 * with it, and every omo or gjc pane that had finished read READY again after an update.
 * So the finished panes are kept in a file too, for the herdr they were seen in: a herdr
 * started anew reuses pane ids for other panes, and its socket is then another file. The
 * panes still working are not: what became of them while this server was down (finished,
 * and seen at herdr's terminal?) is unknown, and a DONE nobody needs is an alert too.
 */

export type OmoRest = "failed" | "failed-before" | "answered";

export class CompletionTracker {
  private readonly worked = new Map<string, string | null>();
  private readonly finished = new Map<string, string | null>();
  private readonly failedRest = new Set<string>();
  private readonly reported = new Map<string, AgentStatus>();
  private readonly pending = new Map<number, Map<string, AgentStatus | null>>();
  private order = 0;
  private saved = "";

  /**
   * `reportedOnly` (herdr-core): a status is the program's own report (OSC 7501) or one its own session files give (OmO, GJC,
   * a resting Claude), never a guess from the screen.
   */
  constructor(private readonly file: string | null = null, private readonly herdr: () => string | null = herdrSocketId, private readonly reportedOnly: () => boolean = () => false) {
    if (file === null) return;
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as { herdr?: unknown; finished?: unknown; finishedAgents?: unknown };
      const current = herdr();
      if (current === null || state.herdr !== current) return;
      const agents = state.finishedAgents && typeof state.finishedAgents === "object" && !Array.isArray(state.finishedAgents)
        ? state.finishedAgents as Record<string, unknown> : {};
      for (const pane of Array.isArray(state.finished) ? state.finished : []) {
        if (typeof pane === "string") this.finished.set(pane, typeof agents[pane] === "string" ? agents[pane] as string : null);
      }
      this.saved = this.serialize(current);
    } catch { /* none yet, or unreadable: start empty */ }
  }

  observe(paneId: string, status: AgentStatus, agent: string | null = null, rest?: OmoRest): AgentStatus {
    if (status === "idle" && (rest === "failed" || rest === "failed-before")) {
      this.worked.delete(paneId);
      if (rest === "failed") this.finished.delete(paneId);
    }
    if (status === "idle" && rest === "answered" && this.failedRest.has(paneId)) this.worked.set(paneId, agent);
    const reported = this.settle(paneId, status, agent);
    if (status === "idle" && (rest === "failed" || rest === "failed-before")) this.failedRest.add(paneId);
    else if (rest === "answered") this.failedRest.delete(paneId);
    this.record(paneId, reported, ++this.order);
    this.save();
    return reported;
  }

  seen(paneId: string): boolean {
    const changed = this.finished.delete(paneId);
    const current = this.reported.get(paneId);
    if (changed || current !== undefined) this.record(paneId, changed ? "idle" : current!, ++this.order);
    if (changed) this.save();
    return changed;
  }

  adopt(paneId: string, agent: string, from: readonly string[]): void {
    let kept = false;
    for (const state of [this.finished, this.worked]) {
      if (!state.has(paneId)) continue;
      const was = state.get(paneId) ?? null;
      if (was === null || was === agent || from.includes(was)) { state.set(paneId, agent); kept = true; }
      else state.delete(paneId);
    }
    if (!kept) {
      this.reported.delete(paneId);
      for (const changes of this.pending.values()) changes.delete(paneId);
    }
    this.save();
  }

  /**
   * Between two statuses at rest it is news only while the pane is shown as working (`unknown`
   * under another agent's name reads as work going on): herdr reads a finish nobody saw
   * as `done` in one place and `idle` in another, and that difference must not undo a DONE.
   */
  replayed(paneId: string, status: AgentStatus, before: { before: AgentStatus; agent: string | null }): boolean {
    const busy = (value: AgentStatus): boolean => value === "working" || value === "blocked";
    const shown = this.reported.get(paneId);
    const unseenWork = busy(before.before) && !busy(status) && !this.worked.has(paneId) && !this.finished.has(paneId) && (shown === undefined || !busy(shown));
    if (shown === undefined || unseenWork) {
      this.observe(paneId, before.before, before.agent);
      return true;
    }
    if (this.reportedOnly() && status !== shown) return true;
    return busy(shown) || busy(status) || busy(before.before);
  }

  resync(panes: readonly { pane_id: string; agent_status: AgentStatus; agent?: string | null }[], newer: ReadonlySet<string>): void {
    const live = new Set(panes.map((pane) => pane.pane_id));
    for (const pane of panes) {
      if (newer.has(pane.pane_id)) continue;
      const agent = pane.agent ?? null;
      if (pane.agent_status !== "working" && pane.agent_status !== "blocked" && this.worked.has(pane.pane_id)) {
        const worker = this.worked.get(pane.pane_id);
        this.worked.delete(pane.pane_id);
        if (agent !== null && (!this.reportedOnly() || (pane.agent_status === "idle" && worker === agent))) this.finished.set(pane.pane_id, agent);
      }
      this.record(pane.pane_id, this.settle(pane.pane_id, pane.agent_status, agent), ++this.order);
    }
    for (const paneId of new Set([...this.worked.keys(), ...this.finished.keys(), ...this.reported.keys()])) {
      if (!live.has(paneId) && !newer.has(paneId)) this.drop(paneId, ++this.order);
    }
    this.save();
  }

  current(paneId: string): AgentStatus | undefined {
    return this.reported.get(paneId);
  }

  async readSnapshot(read: () => Promise<SessionSnapshot>, label?: (snapshot: SessionSnapshot) => Promise<SessionSnapshot>): Promise<SessionSnapshot> {
    const order = ++this.order;
    const newer = new Map<string, AgentStatus | null>();
    this.pending.set(order, newer);
    try {
      const raw = await read();
      // Display labels such as omo must not replace the herdr identity used to match a finish.
      return this.project(raw, newer, order, label ? await label(raw) : raw);
    }
    finally { this.pending.delete(order); }
  }

  present(snapshot: SessionSnapshot): SessionSnapshot {
    return this.project(snapshot, new Map(), ++this.order);
  }

  private project(snapshot: SessionSnapshot, newer: Map<string, AgentStatus | null>, order: number, display = snapshot): SessionSnapshot {
    const statuses = new Map<string, AgentStatus>();
    const ended = new Set<string>();
    for (const pane of snapshot.panes) {
      if (newer.has(pane.pane_id) && newer.get(pane.pane_id) === null) {
        ended.add(pane.pane_id);
        continue;
      }
      const status = newer.has(pane.pane_id) ? newer.get(pane.pane_id)!
        : this.settle(pane.pane_id, pane.agent_status, pane.agent ?? null);
      if (!newer.has(pane.pane_id)) this.record(pane.pane_id, status, order);
      if (status !== pane.agent_status) statuses.set(pane.pane_id, status);
    }
    const live = new Set(snapshot.panes.map((pane) => pane.pane_id));
    for (const pane of new Set([...this.worked.keys(), ...this.finished.keys(), ...this.reported.keys()])) {
      if (!live.has(pane) && !newer.has(pane)) this.drop(pane, order);
    }
    this.save();
    if (statuses.size === 0 && ended.size === 0) return display;
    return {
      ...display,
      panes: display.panes.filter((pane) => !ended.has(pane.pane_id)).map((pane) => statuses.has(pane.pane_id) ? { ...pane, agent_status: statuses.get(pane.pane_id)! } : pane),
      agents: display.agents.filter((agent) => !ended.has(agent.pane_id)).map((agent) => statuses.has(agent.pane_id) ? { ...agent, agent_status: statuses.get(agent.pane_id)! } : agent),
    };
  }

  forget(paneId: string): void {
    this.drop(paneId, ++this.order);
    this.save();
  }

  private drop(paneId: string, order: number): void {
    this.worked.delete(paneId);
    this.failedRest.delete(paneId);
    this.finished.delete(paneId);
    this.record(paneId, null, order);
  }

  private record(paneId: string, status: AgentStatus | null, order: number): void {
    if (status === null) this.reported.delete(paneId);
    else this.reported.set(paneId, status);
    for (const [requested, changes] of this.pending) if (requested < order) changes.set(paneId, status);
  }

  private serialize(herdr: string): string {
    const finished = [...this.finished.keys()].sort();
    const finishedAgents = Object.fromEntries(finished.filter((pane) => this.finished.get(pane) !== null).map((pane) => [pane, this.finished.get(pane)]));
    return JSON.stringify({ herdr, finished, finishedAgents });
  }

  /** Written whole, and only on a change: a crash mid-write must not leave half a file. */
  private save(): void {
    if (this.file === null) return;
    const herdr = this.herdr();
    if (herdr === null) return;
    const state = this.serialize(herdr);
    if (state === this.saved) return;
    try {
      // flushed before the rename, and the rename recorded after it: a power cut never leaves it empty
      writeStateDocument(this.file, state, false);
      this.saved = state;
    } catch (error) {
      console.error(`completion state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private settle(paneId: string, status: AgentStatus, agent: string | null): AgentStatus {
    if (this.finished.has(paneId)) {
      const finishedAgent = this.finished.get(paneId);
      if (agent === null || (finishedAgent === null ? status !== "idle" : finishedAgent !== agent)) this.finished.delete(paneId);
    }
    switch (status) {
      case "working":
      case "blocked":
        if (status === "blocked" && this.reportedOnly()) this.worked.delete(paneId);
        else this.worked.set(paneId, agent);
        this.finished.delete(paneId);
        this.failedRest.delete(paneId);
        return status;
      case "done":
        this.failedRest.delete(paneId);
        this.worked.delete(paneId);
        this.finished.delete(paneId);
        return status;
      case "idle":
        if (this.reportedOnly() && this.worked.has(paneId) && (agent === null || this.worked.get(paneId) !== agent)) this.worked.delete(paneId);
        if (this.worked.delete(paneId)) this.finished.set(paneId, agent);
        return this.finished.has(paneId) ? "done" : status;
      default:
        if (this.reportedOnly()) {
          this.worked.delete(paneId);
          this.finished.delete(paneId);
          return status;
        }
        if (this.worked.has(paneId)) {
          if (agent === null) {
            this.worked.delete(paneId);
            return status;
          }
          if (this.worked.get(paneId) !== agent) return "working";
          this.worked.delete(paneId);
          this.finished.set(paneId, agent);
        }
        return this.finished.has(paneId) && agent !== null ? "done" : status;
    }
  }
}

/**
 * The herdr server this one talks to, as its socket file: a herdr started anew has another.
 * herdr-core's adapter on Windows is a named pipe with no file to stat (a stat opens a connection
 * to it): pipeIdentity stands, as in finishes.ts.
 */
function herdrSocketId(): string | null {
  const path = herdrSocketPath();
  if (isNamedPipe(path)) return pipeIdentity(path);
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}
