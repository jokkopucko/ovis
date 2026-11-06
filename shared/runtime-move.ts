import type { SessionHistoryAgent } from "./session-history.ts";

/**
 * The move of this PC's whole herdr session to herdr-core (docs/runtime-move.md): all of it or
 * nothing. herdr itself is never closed or changed by a move; agents Ovis ends there are reopened on
 * their own conversation in their own pane if the move cannot finish.
 */

/** A tab's panes as herdr splits them: a pane, or a split whose `first` side is left (`right`) or on top (`down`). */
export type MoveNode = { pane: string } | { split: "right" | "down"; ratio: number; first: MoveNode; second: MoveNode };

/**
 * What becomes of one pane:
 * - `resume`: an idle agent whose conversation this PC's stores list; it is ended in herdr and reopens on it.
 *   `ended`: the person ended it already (the pane is a shell again and still names the conversation).
 * - `fresh`: an idle agent whose conversation cannot be told; it is ended in herdr and starts new in the same folder.
 * - `shell`: a shell with nothing running in front; a new shell starts in the same folder.
 * - `busy`: an agent at work or waiting for an answer, or a shell running a command: nothing moves until it is done.
 * - `needs_you`: an agent Ovis cannot end by itself (its input line cannot be read, so the exit could send
 *   text typed there); the person ends it, then the move can go and reopens its conversation.
 */
export type MoveVerdict =
  | { kind: "resume"; agent: SessionHistoryAgent; session_id: string; argv: string[]; ended: boolean }
  | { kind: "fresh"; agent: string }
  | { kind: "shell" }
  | { kind: "busy"; reason: "agent_working" | "agent_waiting" | "command_running"; agent: string | null; command: string | null }
  | { kind: "needs_you"; agent: string };

export interface MovePane {
  pane_id: string;
  cwd: string | null;
  /** the name the person gave the pane, else null */
  name: string | null;
  verdict: MoveVerdict;
}

export interface MoveTab {
  tab_id: string;
  name: string;
  root: MoveNode;
}

export interface MoveWorkspace {
  workspace_id: string;
  name: string;
  tabs: MoveTab[];
}

export interface MovePlan {
  workspaces: MoveWorkspace[];
  panes: MovePane[];
  /** no pane is `busy` or `needs_you`: the move can go now */
  ready: boolean;
  /** changes whenever anything the plan shows changes: a start names the plan it was shown */
  revision: string;
}

/**
 * Why no move is offered: the server does not serve herdr, the PC has no herdr-core or the runtime
 * cannot be switched from here, or the Herdr app is installed and may arrange the core itself.
 */
export type MoveUnavailable = "not_herdr" | "no_herdr_core" | "runtime_locked" | "herdr_app";

/**
 * Where the move is: `idle` (none asked for), `waiting` (asked for; it goes by itself once no pane is
 * busy), `moving` (ending agents, then building everything on herdr-core), `done` (the runtime is
 * switching to herdr-core), `rolled_back` (it could not finish: everything Ovis did is undone, `reason`
 * says why; `left` names the agents it could not reopen in herdr and why), `interrupted` (a server
 * stopped mid-move: see `left`).
 */
export type MoveStatus =
  | { state: "idle" }
  | { state: "waiting"; revision: string }
  | { state: "moving"; step: "ending_agents" | "building" | "starting_agents" | "switching"; done: number; total: number }
  | { state: "done" }
  | { state: "rolled_back" | "interrupted"; reason: string; left: { pane_id: string; agent: string; why: string }[] };

export type MovePlanResponse = ({ available: true; plan: MovePlan } | { available: false; reason: MoveUnavailable }) & { status: MoveStatus };

/** POST /api/runtime/move: the plan's revision as shown. Busy panes make it wait; DELETE cancels a wait. */
export interface MoveStartRequest {
  revision: string;
}
