import { createHash, randomUUID } from "node:crypto";

import type { ConversationMetadata, ConversationTurn } from "../shared/protocol.ts";

/**
 * A transcript is read a page at a time, the newest page re-read on every append
 * while an agent works: Codex rollouts reach hundreds of MB (a 400MB one took 1.1s
 * and 1.7GB of memory to parse whole). 16MB still holds dozens of turns of a
 * tool-heavy session; the chat asks for the pages before it as the reader scrolls up.
 */
export const TRANSCRIPT_WINDOW_BYTES = 16 * 1024 * 1024;

export const COPILOT_UNAVAILABLE_REASONS = [
  "copilot_report_invalid", "copilot_process_lookup_failed", "copilot_process_set_unproved",
  "copilot_peer_process_replaced", "copilot_handoff_unproved", "copilot_peer_conflict",
  "copilot_foreground_unproved", "copilot_resume_unproved",
] as const;
/** Fixed stages a diagnostic may name: Copilot's rejections, and an agent pane herdr gives no folder. */
export const UNAVAILABLE_DIAGNOSTICS = [...COPILOT_UNAVAILABLE_REASONS, "agent_cwd_missing", "devin_current_session_unverified"] as const;

export class ConversationUnavailable extends Error {
  /** `screen`: the model and effort the agent's own live status line states (start-screen.ts), for the scrollback standing in */
  constructor(reason: string, readonly screen?: ConversationMetadata, readonly diagnostic?: typeof UNAVAILABLE_DIAGNOSTICS[number]) {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

/** A read failed, but the pane still proves the same current conversation: retain the view and retry. */
export class ConversationReadPending extends Error {
  constructor() {
    super("The conversation could not be read; try again shortly.");
    this.name = "ConversationReadPending";
  }
}

/** The pane's agent holds a session it has not written yet: a conversation with no turns, not a missing one. */
export class ConversationNotStarted extends ConversationUnavailable {
  constructor(readonly sessionId: string, readonly source: RecognizedConversation["source"] = "omo-transcript", readonly identity: string = sessionId) {
    super("session_not_written");
    this.name = "ConversationNotStarted";
  }
}

/** A cursor from another transcript: the pane started a new session, or a Codex backtrack replaced the file. */
export class HistoryChanged extends Error {
  constructor() {
    super("the conversation's transcript changed; reload it from its newest turns");
    this.name = "HistoryChanged";
  }
}

/** What paneConversation resolved: which store the turns came from, and where they start. */
export type RecognizedConversation = {
  activity?: "thinking" | "working" | "idle";
  source: "dsh-transcript" | "copilot-transcript" | "grok-transcript" | "agy-transcript" | "muse-transcript" | "letta-transcript" | "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "pi-transcript" | "cmd-transcript" | "codex-transcript" | "devin-transcript" | "opencode-transcript" | "hermes-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** `metadata` was read off the agent's own screen (ConversationResponse.screen) */
  screen?: true;
  /** the first turn's position, for the page before it; null at the conversation's beginning */
  cursor: string | null;
  /**
   * Turns the file holds on paths a `/tree` walked away from, which no page of this conversation
   * can reach; absent for every agent that keeps no entry tree. pi moves its leaf without writing
   * anything, so the chat would otherwise drop those turns with no sign they were ever there.
   */
  abandoned?: { count: number; branches: number; summary: string | null };
  history_id: string;
  /** changes whenever the answer could: the route's ETag, so an unchanged poll costs no body */
  version: string;
};

/** The stores read as one append-only file: OpenCode's and Devin's databases are paged by opencode.ts and devin.ts. */
export type StreamSource = Exclude<RecognizedConversation["source"], "opencode-transcript" | "devin-transcript" | "hermes-transcript" | "dsh-transcript">;

/** A restart may parse the same files differently: its answers never match an earlier ETag. */
const PROCESS_VERSION = randomUUID();

export function answerVersion(key: string, signature: string): string {
  return createHash("sha256").update(`${PROCESS_VERSION}\0${key}\0${signature}`).digest("base64url").slice(0, 22);
}

/**
 * Which turns: without `before`, the newest page (with `from`, from that held start
 * while it is still inside the newest page); with `before`, the page ending there,
 * never reaching back past `since`.
 */
export type ConversationPage = {
  before?: string; since?: string; from?: string; history_id?: string;
  /** Prompts per page, when the reader asks for a page size (bounded by the server's own cap). */
  prompts?: number;
};
