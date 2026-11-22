import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";

import type { ConversationMetadata, ConversationResponse, ConversationTurn } from "../shared/protocol.ts";

/**
 * A transcript is read a page at a time, the newest page re-read on every append
 * while an agent works: Codex rollouts reach hundreds of MB (a 400MB one took 1.1s
 * and 1.7GB of memory to parse whole). 16MB still holds dozens of turns of a
 * tool-heavy session; the chat asks for the pages before it as the reader scrolls up.
 */
export const TRANSCRIPT_WINDOW_BYTES = 16 * 1024 * 1024;

export const COPILOT_STORE_DIAGNOSTICS = [
  "copilot_store_unproved", "copilot_process_unproved", "copilot_reader_capacity",
  "copilot_log_unreadable", "copilot_log_missing", "copilot_log_ambiguous", "copilot_log_replaced",
  "copilot_log_truncated", "copilot_log_gap", "copilot_log_metadata_changed", "copilot_log_rewritten",
  "copilot_log_limit", "copilot_log_read_raced", "copilot_log_partial", "copilot_session_unregistered",
  "copilot_marker_unreadable", "copilot_marker_missing", "copilot_marker_ambiguous",
  "copilot_session_directory_unproved",
] as const;
export const COPILOT_UNAVAILABLE_REASONS = [
  ...COPILOT_STORE_DIAGNOSTICS,
  "copilot_report_invalid", "copilot_process_lookup_failed", "copilot_process_set_unproved",
  "copilot_peer_process_replaced", "copilot_handoff_unproved", "copilot_peer_conflict",
  "copilot_foreground_unproved", "copilot_resume_unproved",
  "copilot_report_missing", "copilot_report_mismatch", "copilot_transcript_unreadable",
  "copilot_api_unsupported_platform", "copilot_api_process_unproved", "copilot_api_endpoint_unproved",
  "copilot_api_process_changed", "copilot_api_rpc_failed", "copilot_api_rpc_timeout",
  "copilot_api_malformed_rpc", "copilot_api_rpc_rejected", "copilot_api_unsupported_protocol",
  "copilot_api_foreground_changed", "copilot_api_no_foreground", "copilot_api_transcript_unproved",
] as const;
const COPILOT_SETTLED = new Set<string>(["copilot_session_unregistered", "copilot_peer_conflict", "copilot_report_mismatch",
  "copilot_api_no_foreground", "copilot_api_foreground_changed"]);
export const copilotRecoverable = (diagnostic: string | undefined): boolean =>
  diagnostic !== undefined && diagnostic.startsWith("copilot_") && !COPILOT_SETTLED.has(diagnostic);
export const UNAVAILABLE_DIAGNOSTICS = [...COPILOT_UNAVAILABLE_REASONS, "agent_cwd_missing", "devin_current_session_unverified"] as const;

export class ConversationUnavailable extends Error {
  constructor(reason: string, readonly screen?: ConversationMetadata, readonly diagnostic?: typeof UNAVAILABLE_DIAGNOSTICS[number], readonly hint?: "copilot_ui_server") {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

export function unavailableReason(error: ConversationUnavailable): ConversationResponse["unavailable"] {
  if (error.diagnostic === "agent_cwd_missing") return "no_folder";
  if (error.diagnostic !== undefined) return undefined;
  switch (error.message) {
    case "no_session_id": case "no_session_path": return "not_found";
    case "no_recognized_transcript": return "no_reader";
    case "transcript_missing": case "transcript_unreadable": case "branch_unreadable": return "unreadable";
    default: return undefined;
  }
}

export class ConversationReadPending extends Error {
  constructor() {
    super("The conversation could not be read; try again shortly.");
    this.name = "ConversationReadPending";
  }
}

/**
 * A file as it was authorized: its device and inode, exact (bigint, as a bigint stat gives them) or as numbers,
 * which round 64-bit file indexes (Windows') and so tell only as much as a number stat does. A bigint stat may
 * give a value past 2^63 (an NFS inode) as negative, where a number stat gives it unsigned (#4089).
 */
export interface FileIdentity { dev: number | bigint; ino: number | bigint }

function sameFile(identity: FileIdentity, opened: FileIdentity): boolean {
  const unsigned = (value: number | bigint) => typeof value === "bigint" ? BigInt.asUintN(64, value) : value;
  const same = (a: number | bigint, b: number | bigint) => {
    const left = unsigned(a), right = unsigned(b);
    return typeof left === "bigint" && typeof right === "bigint" ? left === right : Number(left) === Number(right);
  };
  return same(identity.dev, opened.dev) && same(identity.ino, opened.ino);
}

/**
 * The files the synchronous read in progress is bound to, by path, each as it was authorized. An open of
 * one that finds another file there (a folder swapped in around that open alone) is refused, so no bytes
 * behind an answer come from a file nobody authorized (#3382). Null outside readBound.
 */
let boundFiles: Map<string, FileIdentity> | null = null;

export function readBound<T>(files: readonly (readonly [string, FileIdentity])[], read: () => T): T {
  const outer = boundFiles;
  boundFiles = new Map(outer ?? []);
  for (const [path, identity] of files) bindFile(path, identity);
  try { return read(); } finally { boundFiles = outer; }
}

export function* boundSteps<T>(files: readonly (readonly [string, FileIdentity])[], steps: Generator<void | Promise<void>, T, void>): Generator<void | Promise<void>, T, void> {
  const bound = readBound(files, () => boundFiles!);
  let failed: { error: unknown } | undefined;
  for (;;) {
    const outer = boundFiles;
    boundFiles = bound;
    let step: IteratorResult<void | Promise<void>, T>;
    try { step = failed === undefined ? steps.next() : steps.throw(failed.error); }
    finally { boundFiles = outer; }
    failed = undefined;
    if (step.done) return step.value;
    try { yield step.value; } catch (error) { failed = { error }; }
  }
}

export function bindFile(path: string, identity: FileIdentity): void {
  if (boundFiles !== null && !boundFiles.has(path)) boundFiles.set(path, { dev: identity.dev, ino: identity.ino });
}

/** Refuses `fd`, opened from `path`, when `path` is bound to another file: the read is pending. */
export function checkBound(path: string, fd: number): void {
  if (boundFiles?.has(path) === true) checkBoundFile(path, fstatSync(fd, { bigint: true }));
}

/** Refuses `opened`, a file opened from `path` (its stats), when `path` is bound to another file: the read is pending. */
export function checkBoundFile(path: string, opened: FileIdentity): void {
  const identity = boundFiles?.get(path);
  if (identity !== undefined && !sameFile(identity, opened)) throw new ConversationReadPending();
}

/**
 * openSync of `path`, closed and refused where it is bound to another file (checkBound). O_NONBLOCK: a FIFO
 * put there is opened at once, for the check to refuse, never waited on.
 */
export function openBound(path: string, flags: number | string = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)): number {
  const fd = openSync(path, flags);
  try { checkBound(path, fd); } catch (error) { closeSync(fd); throw error; }
  return fd;
}

export class ConversationNotStarted extends ConversationUnavailable {
  constructor(readonly sessionId: string, readonly source: RecognizedConversation["source"] = "omo-transcript", readonly identity: string = sessionId) {
    super("session_not_written");
    this.name = "ConversationNotStarted";
  }
}

export class HistoryChanged extends Error {
  constructor() {
    super("the conversation's transcript changed; reload it from its newest turns");
    this.name = "HistoryChanged";
  }
}

export type RecognizedConversation = {
  activity?: "thinking" | "working" | "idle";
  source: "dsh-transcript" | "kiro-transcript" | "copilot-transcript" | "grok-transcript" | "agy-transcript" | "muse-transcript" | "letta-transcript" | "kimi-transcript" | "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "pi-transcript" | "cmd-transcript" | "codex-transcript" | "devin-transcript" | "opencode-transcript" | "hermes-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  screen?: true;
  cursor: string | null;
  /**
   * Turns the file holds on paths a `/tree` walked away from, which no page of this conversation
   * can reach; absent for every agent that keeps no entry tree. pi moves its leaf without writing
   * anything, so the chat would otherwise drop those turns with no sign they were ever there.
   */
  abandoned?: { count: number; branches: number; summary: string | null };
  transcript_bytes?: number;
  history_id: string;
  version: string;
};

export type StreamSource = Exclude<RecognizedConversation["source"], "opencode-transcript" | "devin-transcript" | "hermes-transcript" | "dsh-transcript" | "kiro-transcript">;

const PROCESS_VERSION = randomUUID();

export function answerVersion(key: string, signature: string): string {
  return createHash("sha256").update(`${PROCESS_VERSION}\0${key}\0${signature}`).digest("base64url").slice(0, 22);
}

export type ConversationPage = {
  before?: string; since?: string; from?: string; history_id?: string;
  prompts?: number;
};
