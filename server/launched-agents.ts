import type { AgentStatus } from "../shared/protocol.ts";
import type { RecognizedConversation } from "./conversation.ts";

/**
 * Most agents write no session until the first message (Codex its rollout, Claude its session id,
 * OpenCode its session row), so nothing ties such a pane to a transcript and its chat would read as
 * unavailable.
 *
 * Until the agent was seen at rest its status is its startup's: Codex reports `working` while it
 * draws, Claude `blocked` at its folder question.
 */
const SOURCES: Record<string, RecognizedConversation["source"]> = {
  agy: "agy-transcript", claude: "claude-transcript", codex: "codex-transcript", devin: "devin-transcript",
  gjc: "gjc-transcript", grok: "grok-transcript", hermes: "hermes-transcript", omo: "omo-transcript",
  omp: "omp-transcript", opencode: "opencode-transcript", pi: "pi-transcript",
};

export const STARTUP_MS = 30_000;

interface Launch { source: RecognizedConversation["source"]; serial: number; at: number; rested: boolean }

export class LaunchedAgents {
  private readonly panes = new Map<string, Launch>();
  private serial = 0;

  launched(paneId: string, kind: string, now = Date.now()): void {
    const source = Object.hasOwn(SOURCES, kind) ? SOURCES[kind] : undefined;
    if (source === undefined) { this.panes.delete(paneId); return; }
    this.serial += 1;
    this.panes.set(paneId, { source, serial: this.serial, at: now, rested: false });
  }

  notBegun(paneId: string, status: AgentStatus | undefined, now = Date.now()): { source: RecognizedConversation["source"]; historyId: string } | null {
    const launch = this.panes.get(paneId);
    if (launch === undefined) return null;
    const busy = status === "working" || status === "blocked";
    if (!busy && (status === "idle" || status === "done")) launch.rested = true;
    if (busy && (launch.rested || now - launch.at > STARTUP_MS)) { this.panes.delete(paneId); return null; }
    return { source: launch.source, historyId: `unwritten:launch:${paneId}:${launch.serial}` };
  }

  /**
   * Before the first turn there is no work and no finish: an agent drawing its start screen reads
   * `working` and then `done` (Codex, live 2026-10-14), which showed DONE on a pane nobody had asked
   * anything of. A question it asks (Claude's folder question) is a question all the same.
   */
  settle(paneId: string, status: AgentStatus, now = Date.now()): AgentStatus {
    const unbegun = this.notBegun(paneId, status, now) !== null;
    return unbegun && (status === "working" || status === "done") ? "idle" : status;
  }

  forget(paneId: string): void { this.panes.delete(paneId); }
  clear(): void { this.panes.clear(); }
}

export const launchedAgents = new LaunchedAgents();
