/**
 * Agent session transcripts -> structured conversation turns.
 *
 * The recognized stores are provider-native and read-only:
 * - Codex: native rollout JSONL, resolved by session metadata/open descriptors
 *   or a unique pane-text match for shared app-server TUIs (codex.ts).
 * - Claude Code: herdr's agent.get names the session id, the transcript lives
 *   at ~/.claude/projects/<project>/<session>.jsonl (claude-store.ts finds it).
 * - omp: herdr's agent.get hands us the session jsonl path outright under
 *   ~/.omp/agent/sessions/<cwd-slug>/, or ~/.omp/profiles/<name>/agent/sessions/<cwd-slug>/
 *   for `omp --profile <name>` — same shape of truth, one less hop. The path is held to the store
 *   the pane's omp process writes to, which its argv and environment may move (omp.ts
 *   ompStoreLayout); when herdr names none of it, the pane's omp process does.
 * - omo: herdr knows nothing about its store and its label for the pane flips
 *   between `pi` and `claude` as omo spawns model CLIs, so the pane's process
 *   tree routes it and process/session evidence selects a unique transcript
 *   under <its agent dir>/sessions/<cwd-slug>/ (~/.omo/agent unless the process
 *   moved it with OMO_CODING_AGENT_DIR). It writes omp's session shape, so
 *   parseOmpTranscript (transcript-records.ts) reads it.
 * - gjc: its native extension reports the active session for its live process
 *   (gjc-native.ts, gjc-runtime.ts). It writes omp's session shape too.
 * - pi: herdr's agent.get names the session jsonl outright under
 *   ~/.pi/agent/sessions/<cwd-slug>/ (pi.ts). Its records are the session shape
 *   parseOmpTranscript reads, but its file is an entry tree, not a log: /tree
 *   moves the leaf and appends beside the path it left (pi-tree.ts), so the
 *   stream is projected onto the branch the leaf stands on before it is read.
 * - OpenCode: herdr's integration reports the session id, and OpenCode 2 keeps the
 *   session in its own SQLite store (opencode.ts), read by `seq` rather than by
 *   byte offset: its cursors name rows, and it pages and caches on its own.
 *
 * This module turns those files into the conversation the chat lens renders;
 * the pty stays the input path. Pure parsing lives in parseClaudeTranscript /
 * parseOmpTranscript (unit-tested); pane/session/file resolution is
 * integration and lives in paneTranscript.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { readStatuslineContext } from "./statusline.ts";
import nodePath, { basename, dirname, relative, sep, type PlatformPath } from "node:path";
import { authorizedTranscript } from "./transcript-store.ts";

import type { ConversationMetadata, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, paneProcessInfo, paneRead, paneScrollInfo, sessionSnapshot, type ProcessInfo } from "./herdr/client.ts";
import { resolveAgent } from "./pane-context.ts";
import { codexFreshSession, codexHistorySegments, createCodexTranscriptParser, codexOutputText, codexTranscriptPath, defaultCodexHome, forgetAllCodexState, forgetCodexStateFor, paneCodexHome, parseCodexTranscript, readRange } from "./codex.ts";
import { CODEX_IMAGE_REF, CODEX_TOOL_IMAGE_REF, codexOutputPicture, codexTranscriptImage, DataUrlPictureScan, finish, finishAsync, forgetOmpBlobTypes, InlinePictureScan, MAX_IMAGE_BYTES, ompBlobAnchor, ompBlobDigest, ompBlobPictureSteps, type Steps } from "./codex-images.ts";
import { type Held, heldOpenPlatform, openHeldDirectory } from "./held-open.ts";
import { AmbiguousClaudeStore, claudeAttachSession, claudeProcessSession, claudeTranscriptFile, defaultClaudeConfigDir, forgetClaudeSessionFile, forgetClaudeSessions, isClaudeProcess, processClaudeConfigDir } from "./claude-store.ts";
import { forgetGjcPane, forgetGjcState, gjcPidUnderShell, gjcTranscriptForPane, isGjcProcess, storeRelative } from "./gjc-runtime.ts";
import { isOmoProcess, omoProcessIdentity, omoSessionForPane, processEnviron } from "./omo.ts";
import { processAlive, processStartedAtAsync } from "./process-start.ts";
import { ompBlobStore, ompPaneRoute, ompRouteOwns, ompRouteStore, ompRouteTranscript } from "./omp.ts";
import { forgetOpencodeRead, forgetOpencodeState, OPENCODE_IMAGE_REF, opencodeConversation, opencodeDatabasePath, opencodeImage, opencodeReadKey, opencodeSessionId, opencodeToolOutput } from "./opencode.ts";
import { piTranscriptPath, unwrittenSession } from "./pi.ts";
import { cmdTranscriptPath } from "./cmd.ts";
import { defaultDevinDbPath, DevinHistoryUnavailable, devinConversation, forgetDevinState } from "./devin.ts";
import { forgetGrokState, grokProjection, grokToolOutput, parseGrokTranscript, GrokUnavailable } from "./grok.ts";
import { resolveGrokStore } from "./grok-store.ts";
import { AgyUnavailable, agyCatalog, agyToolOutput, forgetAgyState, parseAgyTranscript, withAgyHistory, type AgyProjection } from "./agy.ts";
import { resolveAgyStore, sameAgyStore, type AgyStore } from "./agy-store.ts";
import { museSession, museToolOutput, MuseUnavailable, parseMuseTranscript } from "./muse.ts";
import { resolveMuseSession } from "./muse-store.ts";
import { LettaUnavailable, lettaToolOutput, parseLettaTranscript } from "./letta.ts";
import { resolveLettaTranscript } from "./letta-store.ts";
import { withinRetentionBudget } from "./retention-budget.ts";
import { forgetAllPiIndexes, forgetPiIndex, piAbandonedTurns, piBranchRecords, piBranchSegments } from "./pi-tree.ts";
import { copilotOffsetOutput, copilotOutput, copilotRootRecord, parseCopilotTranscript } from "./copilot.ts";
import { copilotExplicitResume, copilotHandoffSession, copilotProcessSession, copilotTranscriptFile, copilotUnwrittenSession, openCopilotFile } from "./copilot-store.ts";
import { claudeSetting, parseConversationMetadata } from "./conversation-metadata.ts";
import { answerVersion, ConversationNotStarted, ConversationReadPending, ConversationUnavailable, type ConversationPage, HistoryChanged, type RecognizedConversation, type StreamSource, TRANSCRIPT_WINDOW_BYTES } from "./conversation-shared.ts";
import { forgetHermesTranscriptState, hermesConversationPage, hermesToolOutput, hermesTranscriptForPane } from "./hermes.ts";

import { createOmpTranscriptParser, isContextClear, MAX_TURNS, omoTaskResults, parseOmpTranscript, PI_IMAGE_REF, PI_PROMPT_IMAGE_REF, piImageBlock, piMessage, piNotice, piPromptImages, piResults, type TranscriptParser } from "./transcript-records.ts";
import { skillPromptMessage } from "./skill-activity.ts";
import { CLAUDE_IMAGE_REF, claudeImageType, claudeResultText, createClaudeTranscriptParser, entryHostToolResults, isHostHandoff, parseClaudeTranscript, type TranscriptEntry } from "./claude-transcript.ts";
import { forgetSubagents, lineNotifications, subagentDetails, type SubagentDetail } from "./claude-subagents.ts";
import { launchedAgents } from "./launched-agents.ts";
import { readsStartScreen, startScreenMetadata } from "./start-screen.ts";
import { commandTranscriptRecords, PI_EVIDENCE_TYPES, type CommandTranscriptRecord } from "./outcome.ts";
import { type ClaudeBranch, claudeForks, followClaudeBranch, type PromptChain, turnStarts } from "./transcript-turns.ts";
import { devinSessionForPane, isDevinProcess } from "./devin-session.ts";
import { userHome } from "./user-home.ts";

export { isOmoProcess } from "./omo.ts";
export { devinSessionForPane, isDevinProcess } from "./devin-session.ts";
export { createClaudeTranscriptParser, parseClaudeTranscript, unwrapPastes } from "./claude-transcript.ts";
export { TRANSCRIPT_WINDOW_BYTES, ConversationReadPending, ConversationUnavailable, ConversationNotStarted, HistoryChanged, answerVersion, type RecognizedConversation, type ConversationPage } from "./conversation-shared.ts";

const PI_PAGE_CACHE_BYTES = 4 * 1024 * 1024;

/** A page never holds more prompts than this (each opens a user + assistant pair). */
export const MAX_PAGE_PROMPTS = MAX_TURNS / 2;

/**
 * The page size a reader that asks for none gets: every reader before the chat's history setting
 * keeps the page it always had. The chat asks for its own size (`prompts=`, the setting).
 */
export const DEFAULT_PAGE_PROMPTS = MAX_PAGE_PROMPTS;

/** A single turn longer than a window still gets a page of its own, up to this. */
const MAX_PAGE_BYTES = 16 * 1024 * 1024;

/** The prompts a page keeps for this read: the reader's choice, inside the server's own bounds. */
function pagePrompts(page: ConversationPage): number {
  const asked = page.prompts;
  if (typeof asked !== "number" || !Number.isFinite(asked)) return DEFAULT_PAGE_PROMPTS;
  return Math.min(MAX_PAGE_PROMPTS, Math.max(1, Math.floor(asked)));
}

/** Settings recorded once at the start (an omp thinking level) sit before a tail window. */
const METADATA_HEAD_BYTES = 64 * 1024;

/** Session ids are uuids; refusing anything else keeps the path traversal-free. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read sessions by source and canonical path (Claude uses its unique session id): a removed file is not unwritten. */
const writtenSessions = new Set<string>();

/** Re-parse on file changes, including replacement and same-size rewrites. */
const cache = new Map<string, { source: RecognizedConversation["source"]; signature: string; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null; abandoned?: { count: number; branches: number; summary: string | null } }>();

/** A restart may parse the same files differently: its answers never match an earlier ETag. */
const PROCESS_VERSION = randomUUID();
const copilotBindings = new Map<string, { identity: string; prefix: string }>();

function copilotPrefix(paneId: string, identity: string): string {
  const previous = copilotBindings.get(paneId);
  if (previous?.identity === identity) return previous.prefix;
  const prefix = `cp${createHash("sha256").update(`${PROCESS_VERSION}\0${paneId}\0${identity}\0${randomUUID()}`).digest("hex").slice(0, 16)}.`;
  remember(copilotBindings, paneId, { identity, prefix }, PANE_READS_MAX);
  return prefix;
}

function copilotHistoryIdentity(path: string): string {
  try {
    const fd = openCopilotFile(path);
    try {
      const stat = fstatSync(fd);
      return `${stat.dev}:${stat.ino}${transcriptGeneration(path, stat)}`;
    } finally { closeSync(fd); }
  } catch { throw new ConversationUnavailable("transcript_missing"); }
}

function copilotPage(page: ConversationPage, prefix: string): ConversationPage {
  const unbind = (cursor?: string): string | undefined => {
    if (cursor === undefined) return undefined;
    if (!cursor.startsWith(prefix)) throw new HistoryChanged();
    return cursor.slice(prefix.length);
  };
  return { before: unbind(page.before), since: unbind(page.since), from: unbind(page.from), prompts: page.prompts };
}

function bindCopilotAnswer(answer: RecognizedConversation, prefix: string): RecognizedConversation {
  return {
    ...answer,
    history_id: `${prefix}${answer.history_id}`,
    cursor: answer.cursor === null ? null : `${prefix}${answer.cursor}`,
    version: answerVersion(prefix, answer.version),
    turns: answer.turns.map((turn) => ({
      ...turn,
      parts: turn.parts.map((part) => part.kind === "tool" && part.output_ref
        ? { ...part, output_ref: `${prefix}${part.output_ref}` } : part),
    })),
  };
}

/**
 * A transcript as one byte stream: for a paginated Codex rollout the history it
 * continues comes first (codexHistorySegments). Transcripts only grow at the end,
 * so a position in it keeps naming the same turn for as long as the file does.
 */
interface TranscriptStream {
  /** the live file's identity: cursors from any other file are refused */
  id: string;
  /** `offset` is where the segment starts in its file: equal to `start` for a whole prefix */
  files: { path: string; start: number; length: number; offset: number }[];
  length: number;
  floor: number;
  promptStarts?: number[];
  fd?: number;
  /** byte ranges a Claude rewind left off the session's branch (claudeBranch): read as blank lines */
  hidden?: [number, number][];
}

// In-place rewrites keep the inode. Change the cursor generation when observed,
// invalidating settled turns and incremental parsers as well as the response cache.
const transcriptRevisions = new Map<string, { identity: string; size: number; changed: string; generation: string; window?: { start: number; end: number; digests: BigUint64Array } }>();
function transcriptGeneration(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, checkWindow = false): string {
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = transcriptRevisions.get(path);
  let rewritten = previous !== undefined && previous.identity === identity && (stat.size < previous.size || (stat.size === previous.size && changed !== previous.changed));
  // Muse: a rewrite that also grew keeps the inode and passes the checks above, so the window last
  // read must still hold the bytes it held. One read from its start checks it and digests the new
  // window, each chunk once. A growth past the whole window shares no bytes with it, so it counts as
  // a rewrite instead of a read of both. ponytail: the last 16 MiB only, where the settled turns
  // come from; digest the whole log if a rewrite further back matters.
  let window = previous?.identity === identity ? previous.window : undefined;
  if (checkWindow && (window === undefined || stat.size !== previous!.size || changed !== previous!.changed)) {
    // the chunk boundary at or before the last 16 MiB, so the newest page is checked from its first byte
    const start = Math.max(0, Math.floor((stat.size - TRANSCRIPT_WINDOW_BYTES) / WINDOW_CHUNK_BYTES) * WINDOW_CHUNK_BYTES);
    if (window !== undefined && window.end <= start) rewritten = true;
    const check = rewritten ? undefined : window;
    const from = check?.start ?? start;
    const bytes = windowBytes(path, from, stat.size);
    const digests = bytes && chunkDigests(bytes);
    if (check && (!digests || !sameOverlap(check, from, bytes!, digests))) rewritten = true;
    // an empty log keeps no window: it has no bytes to check
    const kept = digests?.slice((start - from) / WINDOW_CHUNK_BYTES);
    window = kept?.length ? { start, end: stat.size, digests: kept } : undefined;
  }
  const generation = rewritten ? randomUUID() : previous?.identity === identity ? previous.generation : "";
  remember(transcriptRevisions, path, { identity, size: stat.size, changed, generation, window }, 64);
  return generation ? `-${generation}` : "";
}

/** Bytes `from` to `to` of a file, or null when they cannot all be read. */
function windowBytes(path: string, from: number, to: number): Buffer | null {
  try {
    const fd = openSync(path, "r");
    try {
      const bytes = Buffer.allocUnsafe(to - from);
      return readSync(fd, bytes, 0, bytes.length, from) === bytes.length ? bytes : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

function transcriptStream(source: StreamSource, path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, codexHome: string, agy?: AgyProjection, fd?: number): TranscriptStream {
  // (a chain whose parent was archived since comes back shorter: codexHistorySegments;
  // a pi branch skips the side paths a /tree left behind: piBranchSegments)
  const grok = source === "grok-transcript" ? grokProjection(path, stat) : null;
  const branch = (source === "pi-transcript" || source === "cmd-transcript") ? piBranchSegments(path, stat.size) : null;
  if ((source === "pi-transcript" || source === "cmd-transcript") && branch === null) throw new ConversationUnavailable("branch_unreadable");
  const segments: { path: string; start: number; end: number }[] = source === "codex-transcript"
    ? codexHistorySegments(path, codexHome).map((segment) => ({ path: segment.path, start: 0, end: segment.end }))
    : grok !== null ? grok.segments.map((segment) => ({ path, ...segment }))
    : agy ? agy.segments.map((segment) => ({ path, ...segment }))
    : branch !== null ? branch.map((segment) => ({ path, start: segment.start, end: segment.end }))
    : [{ path, start: 0, end: stat.size }];
  const files: TranscriptStream["files"] = [];
  let stream = 0;
  for (const segment of segments) {
    // the live file is read to the size it had when it was identified
    const end = segment.path === path ? Math.min(segment.end, stat.size) : segment.end;
    const length = end - segment.start;
    if (length <= 0) continue;
    files.push({ path: segment.path, start: stream, length, offset: segment.start });
    stream += length;
  }
  // Positions count from the start of the whole chain: a cursor names the live file AND
  // the rollouts before it, so one read against another chain (an earlier rollout found
  // later, a parent since archived) answers 409 instead of pointing at other turns.
  // A pi branch is laid out from one file, so its layout stands in for that chain: /tree
  // moves the conversation to other bytes while the file, its inode and its size all stay
  // put. Every range counts by where it starts, and by where it ends too except the last:
  // the last one grows with every append, and history_id must stay stable across appends.
  // Two /tree moves away from the same entry share their head ranges and differ only
  // where their tails begin, so the last range's start is what tells them apart.
  let chain = "";
  if (grok !== null) {
    chain = `-grok-${createHash("sha256").update(path).digest("base64url").slice(0, 10)}-${grok.revision}`;
  } else if (agy) {
    chain = `-agy-${agy.revision}`;
  } else if (branch !== null) {
    const layout = files.map((file, at) => (at === files.length - 1 ? `${file.offset}` : `${file.offset}\0${file.length}`)).join("\n");
    chain = `-${createHash("sha256").update(layout).digest("base64url").slice(0, 10)}`;
  } else if (source === "codex-transcript") {
    const earlier = files.slice(0, -1).map((file) => {
      const identity = statSync(file.path, { throwIfNoEntry: false });
      return `${file.path}\0${file.length}\0${identity ? `${identity.dev}:${identity.ino}` : "-"}`;
    });
    chain = earlier.length === 0 ? "" : `-${createHash("sha256").update(earlier.join("\n")).digest("base64url").slice(0, 10)}`;
  }
  return { id: `${stat.dev.toString(36)}-${stat.ino.toString(36)}${chain}${transcriptGeneration(path, stat, source === "muse-transcript")}`, files, length: stream, floor: 0, promptStarts: grok?.promptStarts ?? agy?.promptStarts, fd };
}

function readStream(stream: TranscriptStream, from: number, to: number): Buffer {
  const chunks: Buffer[] = [];
  for (const file of stream.files) {
    const low = Math.max(from, file.start);
    const high = Math.min(to, file.start + file.length);
    if (low >= high) continue;
    const fd = stream.fd ?? openSync(file.path, "r");
    try {
      const buffer = Buffer.alloc(high - low);
      chunks.push(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, file.offset + (low - file.start))));
    } finally {
      if (stream.fd === undefined) closeSync(fd);
    }
  }
  const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
  // a line off the branch keeps its place, so every offset still names the same bytes, and reads as blank
  for (const [start, end] of stream.hidden ?? []) {
    const low = Math.max(start, from) - from;
    const high = Math.min(end, to, from + bytes.length) - from;
    for (let index = low; index < high; index += 1) if (bytes[index] !== 0x0a) bytes[index] = 0x20;
  }
  return bytes;
}

/** Reset markers are small native control records. Scan each appended byte once,
 * in bounded chunks; retain offsets, never a session-sized string.
 * The same pass keeps the latest provider-specific metadata controls (small lines):
 * changes between the head and newest page are otherwise never read. */
const SETTING_TYPES = ['"model_change"', '"thinking_level_change"'];
const COPILOT_SETTING_TYPES = ['"session.model_change"', '"session.resume"'];
type SettingType = "model_change" | "thinking_level_change" | "copilot_model" | "copilot_effort";
/**
 * Claude names its model and effort on every answer, and a /rewind can leave any of them off the
 * branch, so each field keeps every record that set it since the last clear (where it lies, as
 * `branch.answers` does) and a small line that sets the same value again, shared while it repeats.
 */
type ClaudeSettings = Record<"model" | "effort", { line: string; start: number; end: number }[]>;
const clearScans = new Map<string, { id: string; scanned: number; floor: number; tail: string; settings: Partial<Record<SettingType, { offset: number; end: number; line: string }>>; branch?: ClaudeBranch; claude?: ClaudeSettings }>();

function keepClaudeSetting(settings: ClaudeSettings, entry: unknown, start: number, end: number): void {
  const set = claudeSetting(entry);
  const keep = (field: keyof ClaudeSettings, line: string): void => {
    const last = settings[field].at(-1);
    // a repeated value keeps one string, not one per record
    settings[field].push({ line: last?.line === line ? last.line : line, start, end });
  };
  if (set.model !== undefined) keep("model", JSON.stringify({ type: "assistant", message: { model: set.model } }));
  if (set.effort !== undefined) keep("effort", JSON.stringify({ type: "assistant", effort: set.effort }));
}

/** the ranges in order, those that overlap or adjoin made one */
function mergedRanges(ranges: readonly [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [low, high] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && low <= last[1]) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

/** how many of the ascending values lie before `bound` */
function countBefore<T>(items: readonly T[], value: (item: T) => number, bound: number): number {
  let low = 0, high = items.length;
  while (low < high) { const middle = (low + high) >> 1; if (value(items[middle]!) < bound) low = middle + 1; else high = middle; }
  return low;
}
/** a Claude record that holds a picture, up to the largest one the chat shows, is followed whole when it crosses a window */
const CLAUDE_CARRY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;
function applyHistoryBoundary(path: string, stream: TranscriptStream, source: RecognizedConversation["source"]): void {
  finish(applyHistoryBoundarySteps(path, stream, source, false));
}

/**
 * applyHistoryBoundary in steps a window apart (Steps). With `apart`, the scan works on its own copy of
 * what is kept and puts it back when it ends, so a page read between its steps never sees half of it.
 */
function* applyHistoryBoundarySteps(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], apart: boolean): Steps<void> {
  if (source === "codex-transcript" || source === "grok-transcript" || source === "agy-transcript" || source === "muse-transcript" || source === "letta-transcript") return;
  let scan = clearScans.get(path);
  if (!scan || scan.id !== stream.id || scan.scanned > stream.length || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, scanned: 0, floor: 0, tail: "", settings: {}, ...(source === "claude-transcript" ? { branch: { last: null, ends: new Map(), answers: [], forks: [] }, claude: { model: [], effort: [] } } : {}) };
  } else if (apart) scan = structuredClone(scan);
  const branch = scan.branch;
  let position = scan.scanned;
  let carry = Buffer.alloc(0);
  let skipping = false;
  const isClear = (line: Buffer): boolean => {
    if (!line.includes(source === "claude-transcript" ? "/clear" : "context_clear")) return false;
    try { return isContextClear(JSON.parse(line.toString("utf8")), source); } catch { return false; }
  };
  while (position < stream.length) {
    const end = Math.min(stream.length, position + TRANSCRIPT_WINDOW_BYTES);
    const bytes = Buffer.concat([carry, readStream(stream, position, end)]);
    const base = position - carry.length;
    let offset = 0;
    for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
      const line = bytes.subarray(offset, newline);
      if (!skipping && isClear(line)) {
        scan.floor = base + offset;
        if (scan.claude) scan.claude = { model: [], effort: [] };
      }
      else if (!skipping && source !== "claude-transcript" && (source === "copilot-transcript" ? COPILOT_SETTING_TYPES : SETTING_TYPES).some((type) => line.includes(type))) {
        try {
          const entry: unknown = JSON.parse(line.toString("utf8"));
          const type = entry !== null && typeof entry === "object" && "type" in entry ? entry.type : null;
          if (source === "copilot-transcript") {
            if ((type === "session.model_change" || type === "session.resume") && copilotRootRecord(entry)) {
              const data = entry !== null && typeof entry === "object" && "data" in entry ? entry.data : null;
              if (data !== null && typeof data === "object" && !Array.isArray(data)) {
                const model = type === "session.model_change" ? "newModel" in data ? data.newModel : null
                  : "selectedModel" in data ? data.selectedModel : null;
                const setting = { offset: base + offset, end: base + newline, line: line.toString("utf8") };
                if (typeof model === "string" && model.trim() && !model.startsWith("<")) scan.settings.copilot_model = setting;
                if ("reasoningEffort" in data) scan.settings.copilot_effort = setting;
              }
            }
          } else if (type === "model_change" || type === "thinking_level_change") {
            scan.settings[type] = { offset: base + offset, end: base + newline, line: line.toString("utf8") };
          }
        } catch { /* not a record */ }
      }
      if (branch) {
        if (skipping) branch.last = null;
        else {
          const entry = followClaudeBranch(branch, line, base + offset, base + newline + 1, scan.floor);
          if (entry !== undefined && scan.claude) keepClaudeSetting(scan.claude, entry, base + offset, base + newline);
        }
      }
      skipping = false;
      offset = newline + 1;
      scan.scanned = base + offset;
    }
    carry = bytes.subarray(offset);
    // An oversized data record cannot be a native clear control envelope; a Claude prompt that is a
    // screenshot can still be where the session's branch forks
    if (carry.length > (branch ? CLAUDE_CARRY_BYTES : METADATA_HEAD_BYTES)) { carry = Buffer.alloc(0); skipping = true; }
    position = end;
    if (position < stream.length) yield;
  }
  scan.tail = bytesBefore(stream, scan.scanned);
  remember(clearScans, path, scan, 32);
  // A valid final JSON object is visible before its newline; rescan it on append.
  stream.floor = !skipping && carry.length > 0 && isClear(carry) ? stream.length - carry.length : scan.floor;
  if (stream.floor > 0) stream.id += `-clear-${stream.floor.toString(36)}`;
  const forks = branch ? claudeForks(branch) : [];
  const hidden = forks.filter(([, end]) => end > stream.floor);
  if (hidden.length > 0) {
    stream.hidden = hidden;
    // the branch moved: what was read before reads otherwise now, as after a clear
    stream.id += `-fork-${hidden.length}-${hidden.at(-1)![1].toString(36)}`;
  }
}

/**
 * The page of turns ending at `to`: at most MAX_PAGE_PROMPTS prompts, starting on a
 * line that opens a turn, at `floor` (a held start) or at the very beginning. An
 * older page is read once, so for a turn longer than a window it reaches further
 * back, a new chunk at a time, up to MAX_PAGE_BYTES. The newest page is read on
 * every append, so it never does: with no turn start in its window it starts
 * mid-turn, at a whole line.
 */
function pageBefore(stream: TranscriptStream, source: StreamSource, to: number, { floor = stream.floor, widen, prompts }: { floor?: number; widen: boolean; prompts: number }): { start: number; bytes: Buffer } {
  let from = Math.max(floor, to - TRANSCRIPT_WINDOW_BYTES);
  let bytes = readStream(stream, from, to);
  for (;;) {
    const starts = stream.promptStarts ? stream.promptStarts.filter((at) => at >= from && at < to).map((at) => at - from) : turnStarts(bytes, source, undefined, turnBlobs(stream, source));
    const keep = starts.length > prompts ? starts[starts.length - prompts] : from === floor ? 0 : starts[0];
    if (keep !== undefined) return { start: from + keep, bytes: bytes.subarray(keep) };
    if (!widen || to - from >= MAX_PAGE_BYTES) {
      const firstLine = bytes.indexOf(0x0a) + 1;
      return { start: from + firstLine, bytes: bytes.subarray(firstLine) };
    }
    const next = Math.max(floor, from - TRANSCRIPT_WINDOW_BYTES);
    bytes = Buffer.concat([readStream(stream, next, from), bytes]);
    from = next;
  }
}

/**
 * Keep prompt boundaries and settled turns between reads. Codex, Claude, OMP, OMO and
 * GJC also fold only the live task's appended complete records; other native readers
 * reparse that task. Stream generations and byte boundaries invalidate rewritten history.
 */
interface LiveScan {
  id: string;
  source: StreamSource;
  /** complete lines up to here are scanned */
  scanned: number;
  /** turn starts in the scanned bytes, ascending, none before the window */
  starts: number[];
  /** the bytes just before `scanned`: a file rewritten rather than appended to no longer has them */
  tail: string;
  /** the prompt chain the scanned lines end on, which the next appended lines continue */
  chain: PromptChain;
}
const liveScans = new Map<string, LiveScan>();

interface SettledTurns {
  source: RecognizedConversation["source"];
  id: string;
  /** the page start these turns begin at, and the turn start they end at */
  start: number;
  end: number;
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** the bytes just before `end` (see LiveScan.tail) */
  tail: string;
  /** what OmO's `task` calls on the page called their tasks: a task can end in a later turn than the one that started it */
  taskTitles: Map<string, string>;
  /** Claude completion identities in this page's settled prefix only; never inherited from another page. */
  noticed: Set<string>;
  /** the titles it began with, from the pages before it */
  inherited: Map<string, string>;
  /** End of the live turn the last poll actually read; replay never scans unseen skipped history. */
  observedEnd: number;
  /** the pi agent directory whose catalogs the metadata's window was read from (transcriptPage) */
  piAgentDir?: string | null;
}
const settledTurns = new Map<string, SettledTurns>();

function bytesBefore(stream: TranscriptStream, offset: number): string {
  return readStream(stream, Math.max(0, offset - 64), offset).toString("latin1");
}

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/**
 * What a pane's chat has read, so its parsed state can be released when the pane closes.
 *
 * Every cache below is keyed by file, not by pane, and a bridge runs for weeks: without
 * this, everything a pane ever read stays for the life of the process. The release is by
 * path (and by the written-session key), which is what the maps are keyed by, and each
 * reader keeps its own bound so an entry that outlives its pane is still capped.
 */
interface DevinPaneRead { sessionId: string; cwd: string; dbPath?: string }
interface PaneReads { paths: Set<string>; sessions: Set<string>; devin: Map<string, DevinPaneRead> }
const paneReads = new Map<string, PaneReads>();
/** panes remembered; past this a pane that closed long ago is the one whose release is lost */
const PANE_READS_MAX = 128;

function emptyPaneReads(): PaneReads { return { paths: new Set<string>(), sessions: new Set<string>(), devin: new Map<string, DevinPaneRead>() }; }

function rememberPaneRead(paneId: string, path: string): void {
  const reads = paneReads.get(paneId) ?? emptyPaneReads();
  reads.paths.add(path);
  remember(paneReads, paneId, reads, PANE_READS_MAX);
}

function rememberPaneSession(paneId: string, session: string): void {
  const reads = paneReads.get(paneId) ?? emptyPaneReads();
  reads.sessions.add(session);
  remember(paneReads, paneId, reads, PANE_READS_MAX);
}

function rememberPaneDevin(paneId: string, sessionId: string, cwd: string, dbPath?: string): void {
  const reads = paneReads.get(paneId) ?? emptyPaneReads();
  const key = JSON.stringify([dbPath ?? defaultDevinDbPath(), sessionId, cwd]);
  reads.devin.set(key, { sessionId, cwd, dbPath });
  remember(paneReads, paneId, reads, PANE_READS_MAX);
}

/** Pi retains at most four small parsed pages per cache; oversized pages remain readable uncached. */
function rememberPage<T extends { source: RecognizedConversation["source"] }>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  if ((value.source === "pi-transcript" || value.source === "cmd-transcript") && !withinRetentionBudget(value, PI_PAGE_CACHE_BYTES)) return;
  remember(map, key, value, limit);
  const piKeys = [...map].filter(([, item]) => item.source === "pi-transcript" || item.source === "cmd-transcript").map(([key]) => key);
  while (piKeys.length > 4) map.delete(piKeys.shift()!);
}

/** The newest page's start and every turn start in it (pageBefore without widening), or null when it starts mid-turn. */
function newestPage(path: string, stream: TranscriptStream, source: StreamSource, prompts: number): { start: number; starts: number[] } | null {
  const from = Math.max(stream.floor, stream.length - TRANSCRIPT_WINDOW_BYTES);
  if (stream.promptStarts) {
    const starts = stream.promptStarts.filter((at) => at >= from);
    const start = starts.length > prompts ? starts[starts.length - prompts] : from === stream.floor ? stream.floor : starts[0];
    return start === undefined ? null : { start, starts };
  }
  let scan = liveScans.get(path);
  // a window that slid past the scanned bytes starts over at its edge (a line may be cut
  // there, as in pageBefore, and never counts as a start)
  if (!scan || scan.id !== stream.id || scan.source !== source || scan.scanned > stream.length || scan.scanned < from
    || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, source, scanned: from, starts: [], tail: bytesBefore(stream, from), chain: { parent: null, answered: true } };
  }
  let pending: number[] = [];
  if (scan.scanned < stream.length) {
    const bytes = readStream(stream, scan.scanned, stream.length);
    const complete = bytes.lastIndexOf(0x0a) + 1;
    for (const offset of turnStarts(bytes.subarray(0, complete), source, scan.chain, turnBlobs(stream, source))) scan.starts.push(scan.scanned + offset);
    // a last line still without its newline counts now, and is scanned again once
    // complete, so it is scanned on a copy that leaves the kept chain untouched
    pending = turnStarts(bytes.subarray(complete), source, { ...scan.chain }, turnBlobs(stream, source)).map((offset) => scan!.scanned + complete + offset);
    scan.scanned += complete;
    scan.tail = bytesBefore(stream, scan.scanned);
  }
  const stale = scan.starts.findIndex((offset) => offset >= from);
  if (stale !== 0) scan.starts.splice(0, stale === -1 ? scan.starts.length : stale);
  remember(liveScans, path, scan, 32);
  const starts = pending.length > 0 ? [...scan.starts, ...pending] : scan.starts;
  const start = starts.length > prompts ? starts[starts.length - prompts] : from === stream.floor ? stream.floor : starts[0];
  return start === undefined ? null : { start, starts };
}

/** Only native notification records name metadata files; quoted tool output names none. */
function collectSubagentIds(text: string, ids: Set<string>): void {
  if (!text.includes("<task-notification>")) return;
  for (const line of text.split("\n")) for (const notice of lineNotifications(line)) if (notice.agent) ids.add(notice.taskId);
}

/** What the meta files of the subagents a Claude page's notifications name say of them: read only when the page has one. */
function subagentsOnPage(path: string, text: string): ReadonlyMap<string, SubagentDetail> | undefined {
  const ids = new Set<string>();
  collectSubagentIds(text, ids);
  return ids.size === 0 ? undefined : subagentDetails(path, ids);
}

function parseTurns(source: RecognizedConversation["source"], path: string, text: string, taskTitles?: Map<string, string>, noticed?: Set<string>, baseOffset?: number): ConversationTurn[] {
  if (source === "copilot-transcript") return parseCopilotTranscript(text, Infinity, baseOffset);
  if (source === "grok-transcript") {
    try { return parseGrokTranscript(text, path); } catch (error) {
      if (error instanceof GrokUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  if (source === "agy-transcript") return parseAgyTranscript(text, path);
  if (source === "muse-transcript") {
    try { return parseMuseTranscript(text, museSession(path)); } catch (error) {
      if (error instanceof MuseUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  if (source === "letta-transcript") {
    try { return parseLettaTranscript(text); } catch (error) {
      if (error instanceof LettaUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  return source === "codex-transcript" ? parseCodexTranscript(text, Infinity)
    : source === "claude-transcript" ? parseClaudeTranscript(text, Infinity, { subagents: subagentsOnPage(path, text), noticed })
      : parseOmpTranscript(text, Infinity, ompReading(source, path, taskTitles));
}

/** How the omp record fold reads a source, the same for a one-shot parse and a live one: pi keeps a
 * picture inline and omp in its blob store, and the image endpoint answers both; omo and gjc are read
 * the same way but would carry image refs nothing answers, so they name none. gjc's tool parts carry
 * their call ids, which the chat matches gjc's rewrites by */
function ompReading(source: RecognizedConversation["source"], path: string, taskTitles?: Map<string, string>) {
  return { images: source === "pi-transcript" || source === "cmd-transcript" || source === "omp-transcript", blobs: source === "omp-transcript" ? ompBlobStore(path) : null, callIds: source === "gjc-transcript", taskTitles };
}

/** The blob store of the omp transcript a stream reads (ompBlobStore), for its turn scan; null for any other agent. */
function turnBlobs(stream: TranscriptStream, source: StreamSource): string | null {
  const live = stream.files.at(-1)?.path;
  return source === "omp-transcript" && live !== undefined ? ompBlobStore(live) : null;
}

type IncrementalSource = "codex-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "claude-transcript";

interface LiveTranscriptTurn {
  source: IncrementalSource;
  id: string;
  start: number;
  /** The requested page determines inherited titles and completion deduplication. */
  pageStart: number;
  prefixBoundary: string;
  scanned: number;
  boundary: string;
  /** Native readers also detect edits away from the trailing boundary during growth. */
  contentHash?: string;
  parser: TranscriptParser;
  metadata: ConversationMetadata;
  subagents?: { ids: Set<string>; details: Map<string, SubagentDetail> };
}
const liveTranscriptTurns = new Map<string, LiveTranscriptTurn>();
/** The original Codex cache's entry/source-byte budgets. OMO and GJC folds have budgets of their
 * own: chats read in turn whose tasks no longer fit evict each other on every poll, so OMO and
 * GJC, folded after the others, must not take room that Codex, OMP or Claude chats have had. */
const LIVE_TURN_ENTRIES = 8;
const LIVE_TURN_BYTES = 2 * TRANSCRIPT_WINDOW_BYTES;
const liveTurnBudget = (source: IncrementalSource) => source === "omo-transcript" || source === "gjc-transcript" ? "omo-gjc" : "codex-omp-claude";

/** Append-only task folds; snapshots never lend mutable state to an earlier HTTP answer. */
function incrementalLiveTurn(path: string, stream: TranscriptStream, source: IncrementalSource, start: number, before: SettledTurns): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  let cached = liveTranscriptTurns.get(path);
  if (cached && (cached.source !== source || cached.id !== stream.id || cached.start !== start
    || cached.pageStart !== before.start || cached.prefixBoundary !== before.tail || cached.scanned > stream.length
    || bytesBefore(stream, cached.scanned) !== cached.boundary)) cached = undefined;

  let details: Map<string, SubagentDetail> | undefined;
  if (cached?.subagents) {
    details = subagentDetails(path, cached.subagents.ids);
    // Metadata is normally immutable, but a file may arrive after its notification.
    // Rebuild that task when an existing card's inputs change, just as a cold read does.
    for (const id of cached.subagents.ids) {
      const previous = cached.subagents.details.get(id);
      const current = details.get(id);
      if (previous?.title !== current?.title || previous?.agent !== current?.agent) {
        cached = undefined;
        details = undefined;
        break;
      }
    }
  }
  // Every reader but Codex used to reread the live task, so growth must not hide an in-place edit.
  // Verify committed bytes without decoding or reparsing them; keep only their digest.
  const currentBytes = source === "codex-transcript" ? undefined : readStream(stream, start, stream.length);
  let digest = currentBytes ? createHash("sha256") : undefined;
  if (currentBytes && cached) {
    digest!.update(currentBytes.subarray(0, cached.scanned - start));
    if (digest!.copy().digest("hex") !== cached.contentHash) {
      cached = undefined;
      details = undefined;
      digest = createHash("sha256");
    }
  }
  if (!cached) {
    const subagents = source === "claude-transcript" ? { ids: new Set<string>(), details: new Map<string, SubagentDetail>() } : undefined;
    const parser = source === "codex-transcript" ? createCodexTranscriptParser()
      : source === "claude-transcript" ? createClaudeTranscriptParser({ subagents: subagents!.details, noticed: new Set(before.noticed) })
      : createOmpTranscriptParser(ompReading(source, path, new Map(before.taskTitles)));
    cached = { source, id: stream.id, start, pageStart: before.start, prefixBoundary: before.tail, scanned: start,
      boundary: bytesBefore(stream, start), parser, metadata: before.metadata, subagents };
  }
  const bytes = currentBytes ? currentBytes.subarray(cached.scanned - start) : readStream(stream, cached.scanned, stream.length);
  const complete = bytes.lastIndexOf(0x0a) + 1;
  const text = bytes.subarray(0, complete).toString("utf8");
  const tail = bytes.subarray(complete).toString("utf8");
  if (cached.subagents) {
    collectSubagentIds(text, cached.subagents.ids);
    if (text.includes("<task-notification>") || tail.includes("<task-notification>")) {
      const ids = new Set(cached.subagents.ids);
      collectSubagentIds(tail, ids);
      details = subagentDetails(path, ids);
    }
    cached.subagents.details.clear();
    for (const [id, detail] of details ?? []) cached.subagents.details.set(id, detail);
  }
  if (complete > 0) {
    cached.parser.write(text);
    cached.metadata = parseConversationMetadata(text, source, cached.metadata);
    cached.scanned += complete;
    cached.boundary = bytesBefore(stream, cached.scanned);
  }
  if (digest) cached.contentHash = digest.update(bytes.subarray(0, complete)).digest("hex");
  // Retain normalized state only, never raw source records or the speculative tail. The least
  // recently read entries of this budget make room.
  liveTranscriptTurns.delete(path);
  liveTranscriptTurns.set(path, cached);
  const budget = [...liveTranscriptTurns].filter(([, turn]) => liveTurnBudget(turn.source) === liveTurnBudget(source));
  let entries = budget.length;
  let retained = budget.reduce((sum, [, turn]) => sum + turn.scanned - turn.start, 0);
  for (const [key, turn] of budget) {
    if (entries <= LIVE_TURN_ENTRIES && retained <= LIVE_TURN_BYTES) break;
    liveTranscriptTurns.delete(key);
    entries -= 1;
    retained -= turn.scanned - turn.start;
  }
  return { turns: cached.parser.snapshot(tail), metadata: parseConversationMetadata(tail, source, cached.metadata) };
}

/** Codex settings belong to the live rollout; native clears bound other stores. A model or
 * thinking-level change after the head and before the page follows the head, in order. */
function metadataHead(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number): string {
  if (source === "codex-transcript") return readRange(path, 0, METADATA_HEAD_BYTES);
  const end = Math.min(start, stream.floor + METADATA_HEAD_BYTES);
  const scan = clearScans.get(path);
  const later = Object.values(scan?.settings ?? {})
    // a record the head cuts in two is read whole here
    .filter((setting) => setting.end > end && setting.offset < start)
    .sort((a, b) => a.offset - b.offset)
    // One control may update both fields; replay the native line once.
    .filter((setting, index, settings) => index === 0 || setting.offset !== settings[index - 1]!.offset)
    .map((setting) => setting.line);
  // Claude: each field's latest record before the page that is still on the branch, when the head does
  // not hold it whole (a record from before a clear ends inside the head, which starts at the clear)
  const hidden = mergedRanges(stream.hidden ?? []);
  for (const records of Object.values(scan?.claude ?? {})) {
    // records ascend by start: a hidden range is passed in one step, not one record at a time
    for (let index = countBefore(records, (setting) => setting.start, start) - 1; index >= 0;) {
      const setting = records[index]!;
      const range = hidden[countBefore(hidden, ([low]) => low, setting.start + 1) - 1];
      if (range !== undefined && range[1] >= setting.end) { index = countBefore(records, (other) => other.start, range[0]) - 1; continue; }
      if (setting.end > end) later.push(setting.line);
      break;
    }
  }
  return [readStream(stream, stream.floor, end).toString("utf8"), ...later].join("\n");
}

/**
 * The newest page's turns from `start`: the settled ones (before the last turn start)
 * from memory, extended by any turn that has since been followed, plus the live last turn.
 */
function liveTurns(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number, starts: number[], piAgentDir?: string | null): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  // starts ascend: the last one, when it lies past the page start
  const last = Math.max(start, starts[starts.length - 1] ?? start);
  const key = `${path}\0${start}`;
  let settled = settledTurns.get(key);
  if (!settled || settled.id !== stream.id || settled.end > last || bytesBefore(stream, settled.end) !== settled.tail || settled.piAgentDir !== piAgentDir) {
    const head = start > stream.floor ? metadataHead(path, stream, source, start) : "";
    // a page that starts past the turn that started a task keeps the title that turn gave it,
    // as long as this stream was watched while the title was on a page (a cold read cannot).
    // Only this file's pages count: another file can come to have its inode once it is gone.
    let kept: SettledTurns | undefined;
    for (const [other, page] of settledTurns) {
      if (other.startsWith(`${path}\0`) && page.id === stream.id && page.start < start && page.start > (kept?.start ?? -1)) kept = page;
    }
    const inherited = new Map(kept === undefined ? [] : kept.end <= start ? kept.taskTitles : kept.inherited);
    // Replay the overlap, or the previously seen live turn when many prompts arrived between
    // polls. Only bytes already observed are needed, even if the file grew by gigabytes since.
    if (kept !== undefined) {
      const from = kept.end <= start ? kept.end : kept.start;
      const to = Math.min(start, kept.observedEnd);
      if (to > from) parseTurns(source, path, readStream(stream, from, to).toString("utf8"), inherited, undefined, from);
    }
    settled = { source, id: stream.id, start, end: start, turns: [], metadata: parseConversationMetadata(`${head}
`, source, undefined, piAgentDir), tail: bytesBefore(stream, start), taskTitles: new Map(inherited), noticed: new Set(), inherited, observedEnd: stream.length, piAgentDir };
  }
  if (settled.end < last) {
    const text = readStream(stream, settled.end, last).toString("utf8");
    settled = { ...settled, end: last, turns: [...settled.turns, ...parseTurns(source, path, text, settled.taskTitles, settled.noticed, settled.end)], metadata: parseConversationMetadata(text, source, settled.metadata, piAgentDir), tail: bytesBefore(stream, last) };
  }
  settled.observedEnd = stream.length;
  rememberPage(settledTurns, key, settled, 8);
  if (source === "codex-transcript" || source === "omp-transcript" || source === "omo-transcript" || source === "gjc-transcript" || source === "claude-transcript") {
    const live = incrementalLiveTurn(path, stream, source, last, settled);
    return { turns: [...settled.turns, ...live.turns], metadata: live.metadata };
  }
  const text = readStream(stream, last, stream.length).toString("utf8");
  // the live turn is parsed again on every poll: its titles and completions are kept only
  // once it settles, so a read titles a task exactly as a cold read of the same bytes does
  return { turns: [...settled.turns, ...parseTurns(source, path, text, new Map(settled.taskTitles), new Set(settled.noticed), last)], metadata: parseConversationMetadata(text, source, settled.metadata, piAgentDir) };
}

/** Retention diagnostics only: counts/budget adherence, never transcript contents. */
export function piPageCacheUsage(): { pages: number; settled: number; withinBudget: boolean } {
  const pages = [...cache.values()].filter(item => item.source === "pi-transcript" || item.source === "cmd-transcript");
  const settled = [...settledTurns.values()].filter(item => item.source === "pi-transcript" || item.source === "cmd-transcript");
  return { pages: pages.length, settled: settled.length, withinBudget: [...pages, ...settled].every(item => withinRetentionBudget(item, PI_PAGE_CACHE_BYTES)) };
}

/** Retention diagnostics only: the live tasks folded between reads, by path, never their contents. */
export function liveTurnCacheUsage(): { paths: string[]; withinBudget: boolean } {
  const turns = [...liveTranscriptTurns.values()];
  const withinBudget = (["codex-omp-claude", "omo-gjc"] as const).every((name) => {
    const budget = turns.filter((turn) => liveTurnBudget(turn.source) === name);
    return budget.length <= LIVE_TURN_ENTRIES && budget.reduce((sum, turn) => sum + turn.scanned - turn.start, 0) <= LIVE_TURN_BYTES;
  });
  return { paths: [...liveTranscriptTurns.keys()], withinBudget };
}

/** Forget every scan and parse kept between polls (tests compare against a cold read). */
export function forgetTranscriptState(): void {
  launchedAgents.clear();
  cache.clear();
  commandTranscripts.clear();
  writtenSessions.clear();
  forgetClaudeSessions();
  forgetGjcState();
  forgetSubagents();
  forgetOpencodeState();
  forgetOmpBlobTypes();
  liveScans.clear();
  settledTurns.clear();
  liveTranscriptTurns.clear();
  transcriptRevisions.clear();
  clearScans.clear();
  paneReads.clear();
  copilotBindings.clear();
  forgetAllCodexState();
  forgetAllPiIndexes();
  forgetGrokState();
  forgetAgyState();
  forgetDevinState();
  forgetHermesTranscriptState();
}

/**
 * Drop everything one pane's chat parsed, the caches here and in the readers below.
 *
 * The maps are keyed by file, so the pane is remembered against what it read
 * (`rememberPaneRead`). Every delete is a memo of a file that still exists: the next read
 * of a live pane re-derives it, and a file nobody reads again costs nothing to forget.
 */
export function forgetPaneTranscriptState(paneId: string): void {
  const reads = paneReads.get(paneId);
  paneReads.delete(paneId);
  copilotBindings.delete(paneId);
  launchedAgents.forget(paneId);
  forgetGjcPane(paneId);
  if (reads === undefined) return;
  // two panes can read one transcript (a resumed session, a shared store): what another pane
  // still reads stays
  const shared = (pick: (other: PaneReads) => Set<string>, value: string): boolean => [...paneReads.values()].some((other) => pick(other).has(value));
  for (const session of reads.sessions) if (!shared((other) => other.sessions, session)) writtenSessions.delete(session);
  for (const [key, session] of reads.devin) {
    if (![...paneReads.values()].some((other) => other.devin.has(key))) forgetDevinState(session.sessionId, session.cwd, session.dbPath);
  }
  for (const path of reads.paths) {
    if (shared((other) => other.paths, path)) continue;
    for (const key of [...cache.keys()]) if (key.startsWith(`${path}\0`)) cache.delete(key);
    transcriptRevisions.delete(path);
    commandTranscripts.delete(path);
    liveScans.delete(path);
    for (const key of [...settledTurns.keys()]) if (key.startsWith(`${path}\0`)) settledTurns.delete(key);
    liveTranscriptTurns.delete(path);
    clearScans.delete(path);
    forgetCodexStateFor(path);
    forgetPiIndex(path);
    forgetGrokState(path);
    forgetAgyState(path);
    forgetClaudeSessionFile(path);
    forgetOpencodeRead(path);
    forgetHermesTranscriptState(path);
  }
}

function formatCursor(stream: TranscriptStream, offset: number): string | null {
  return offset > stream.floor ? `${stream.id}:${offset}` : null;
}

function parseCursor(stream: TranscriptStream, cursor: string): number {
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== stream.id || !Number.isSafeInteger(offset) || offset < stream.floor || offset > stream.length) {
    throw new HistoryChanged();
  }
  return offset;
}

/** gjc's resolver answers null; the chat lens reports why it fell back to scrollback. */
export async function gjcTranscriptPath(paneId: string, cwd: string, home?: string): Promise<string> {
  const path = await gjcTranscriptForPane(paneId, cwd, home);
  if (!path) throw new ConversationUnavailable("no_session_path");
  return path;
}

/**
 * herdr's `pane.process_info` answer a caller already read for this pane, handed down so the same look does not
 * ask again: null when herdr named no processes (none in front), undefined to ask here (also after a failed read).
 */
type KnownProcesses = ProcessInfo | null | undefined;

/**
 * Is omo the agent in this pane, whatever herdr currently labels it? A probe
 * failure answers "no": the caller then reports why the labelled store failed,
 * which is the more useful error.
 */
export async function paneRunsOmo(paneId: string, known?: KnownProcesses): Promise<boolean> {
  // pane.process_info wants `pane_id`; given `target` herdr answers for the
  // FOCUSED pane instead of erroring (live-verified 2026-09-21).
  const info = known !== undefined ? { process_info: known ?? undefined } : await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown; cwd?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  const home = userHome();
  return (info?.process_info?.foreground_processes ?? []).some((process) =>
    // a pid herdr does not report keeps the argv-only proof and fails the custom one closed
    omoProcessIdentity({
      pid: typeof process.pid === "number" ? process.pid : -1,
      argv: Array.isArray(process.argv) ? process.argv.map(String) : undefined,
      cwd: typeof process.cwd === "string" && process.cwd ? process.cwd : undefined,
    }, "", home) !== null,
  );
}

/** A program's name in a process listing: its path's last part, without a Windows or script extension. */
const programName = (word: string): string => nodePath.posix.basename(word.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|js|mjs|cjs)$/i, "");

/**
 * The script an agent's npm package runs as its `bin`, which bunx and npx start under bun or node: omp's is
 * dist/cli.js in @oh-my-pi/pi-coding-agent (18.13.2 package.json `bin`), whose name is not omp (#2280).
 */
const NPM_ENTRIES: Partial<Record<string, RegExp>> = {
  omp: /(^|[\\/])node_modules[\\/]@oh-my-pi[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/i,
};

/**
 * The foreground processes that are `agent` itself: its native binary first, then an interpreter (node, bun,
 * python) running the agent's script or its npm package's entry point (NPM_ENTRIES); for omo, its own process
 * (isOmoProcess). Never the shell that started it. paneProcessRoots and the command outcomes' process binding
 * both pick from here, so they cannot drift.
 */
export function agentProcesses<T extends { argv?: readonly string[] | null; argv0?: string | null; name?: string | null }>(processes: readonly T[], agent: string): T[] {
  const native = processes.filter((entry) => programName(entry.argv?.[0] ?? entry.argv0 ?? entry.name ?? "") === agent);
  const interpreted = processes.filter((entry) => {
    const argv = entry.argv ?? [];
    if (agent === "omo") return isOmoProcess(argv);
    const runtime = programName(argv[0] ?? "");
    return ["node", "bun", "python", "python3"].includes(runtime) && programName(argv[1] ?? "") === agent
      || ["node", "bun"].includes(runtime) && NPM_ENTRIES[agent]?.test(argv[1] ?? "") === true;
  });
  return [...native, ...interpreted.filter((entry) => !native.includes(entry))];
}

/** Loaded roots and environment belong to the foreground agent, not the web server. */
export async function paneProcessRoots(paneId: string, agent: string | null | undefined): Promise<{
  /** `held`: the omo process holds a session there (its own holder record), not only an omo-ai path in its argv. */
  omo: { agentDir: string | null; pluginDir: string | null; held: boolean } | null;
  environ: string[] | null;
  pid: number | null;
  cwd: string | null;
  /** herdr's answer these were read from, for a caller that would otherwise ask again; none when it failed. */
  processes?: ProcessInfo;
}> {
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown; argv0?: unknown; name?: unknown; cwd?: unknown }[] } }>(
    "pane.process_info", { pane_id: paneId },
  ).catch(() => null);
  const processes = info?.process_info as ProcessInfo | undefined;
  const home = userHome();
  const directory = (path: string | null): string | null => {
    try { return path && statSync(path).isDirectory() ? path : null; } catch { return null; }
  };
  const foreground = (info?.process_info?.foreground_processes ?? []).map((candidate) => ({
    pid: typeof candidate.pid === "number" ? candidate.pid : -1,
    argv: Array.isArray(candidate.argv) ? candidate.argv.map(String) : [],
    ...(typeof candidate.argv0 === "string" ? { argv0: candidate.argv0 } : {}),
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    cwd: typeof candidate.cwd === "string" ? candidate.cwd : "",
  }));
  const matched = agent && ["claude", "codex", "omp", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy", "copilot"].includes(agent)
    ? agentProcesses(foreground, agent)[0] ?? null : null;
  // the omo process that holds a session wins over an omo-looking one listed before it (omo's bundled
  // Claude SDK binary under /omo-ai/, a helper script): typing follows the held one
  let chosen: { process: (typeof foreground)[number]; identity: NonNullable<ReturnType<typeof omoProcessIdentity>> } | null = null;
  for (const process of foreground) {
    const identity = omoProcessIdentity(process, "", home);
    if (!identity || (chosen !== null && !identity.held)) continue;
    chosen = { process, identity };
    if (identity.held) break;
  }
  if (chosen !== null) {
    const { process, identity } = chosen;
    const agentDir = directory(identity.agentDir);
    const argv = process.argv.map((word) => word.replace(/\\/g, "/"));
    const extension = argv.find((word, index) => argv[index - 1] === "--extension" && /\/omo-ai\/plugin\/?$/.test(word));
    let pluginDir = directory(extension ? nodePath.resolve(process.cwd, extension) : null);
    if (!pluginDir) {
      const word = argv.find((word) => word.includes("/omo-ai/"));
      if (word) {
        try {
          const canonical = realpathSync(nodePath.resolve(process.cwd, word));
          const paths = nodePath.win32.isAbsolute(canonical) && !nodePath.posix.isAbsolute(canonical) ? nodePath.win32 : nodePath.posix;
          for (let parent = paths.dirname(canonical); parent !== paths.dirname(parent); parent = paths.dirname(parent)) {
            if (paths.basename(parent) === "omo-ai") {
              pluginDir = directory(paths.join(parent, "plugin"));
              break;
            }
          }
        } catch { /* launcher may have gone away; try the installed executable */ }
      }
    }
    if (!pluginDir) {
      const executable = Bun.which("omo");
      if (executable) {
        try { pluginDir = directory(nodePath.join(nodePath.dirname(nodePath.dirname(realpathSync(executable))), "plugin")); }
        catch { /* no readable installed plugin */ }
      }
    }
    return { omo: { agentDir, pluginDir, held: identity.held }, environ: processEnviron(process.pid), pid: process.pid, cwd: process.cwd || null, ...(processes ? { processes } : {}) };
  }
  return { omo: null, environ: matched ? processEnviron(matched.pid) : null, pid: matched?.pid ?? null, cwd: matched?.cwd || null, ...(processes ? { processes } : {}) };
}

/**
 * herdr labels an omo pane `pi` while it waits and `claude` while omo's claude-sdk child
 * runs, so the sidebar showed another agent's mark, and one that changed as omo worked.
 * The snapshots the browser gets name such a pane `omo`, decided by its process tree
 * (paneRunsOmo), including panes herdr has not recognized as an agent.
 */
export async function labelOmoPanes(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  const candidates = snapshot.panes;
  const omo = new Set<string>();
  await Promise.all(candidates.map(async (pane) => { if (await paneRunsOmo(pane.pane_id)) omo.add(pane.pane_id); }));
  if (omo.size === 0) return snapshot;
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => omo.has(pane.pane_id) ? { ...pane, agent: "omo" } : pane),
    agents: snapshot.agents.map((agent) => omo.has(agent.pane_id) ? { ...agent, agent: "omo" } : agent),
  };
}

/** The Claude processes in a pane's foreground (`known`: herdr's answer already read); none when herdr cannot say. */
async function claudeProcesses(paneId: string, known?: KnownProcesses): Promise<{ pid: number; name?: string; argv0?: string; argv?: string[] }[]> {
  if (known !== undefined) {
    return (known?.foreground_processes ?? []).map(({ pid, name, argv0, argv }) => ({
      pid, name, ...(typeof argv0 === "string" ? { argv0 } : {}), ...(Array.isArray(argv) ? { argv } : {}),
    })).filter(isClaudeProcess);
  }
  try {
    const processInfo = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; name?: string; argv0?: string; argv?: string[] }[] } }>(
      "pane.process_info", { pane_id: paneId },
    );
    return processInfo.process_info?.foreground_processes?.filter(isClaudeProcess) ?? [];
  } catch { return []; /* herdr busy: the default store */ }
}

/** The pid of the one Claude process in a pane's foreground, or null. */
export async function claudePanePid(pane: HerdrPane): Promise<number | null> {
  const processes = await claudeProcesses(pane.pane_id);
  return processes.length === 1 ? processes[0]!.pid : null;
}

/**
 * Claude's transcript: Herdr's hook, or a unique live Claude's native PID record, in the config dir
 * of the pane's Claude process (a launcher can give each environment its own CLAUDE_CONFIG_DIR). A
 * `claude attach <id|name>` keeps no PID record: only the state of the job it opened, found as Claude
 * finds it, names the session it shows, never the hook's. `onProcess` learns that process, and
 * whether it is such an attach client.
 */
async function claudeTranscriptPath(paneId: string, cwds: readonly (string | null | undefined)[], onProcess?: (pid: number, attach: boolean) => void, known?: KnownProcesses): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: paneId });
  let session = info.agent.agent_session?.value;
  const home = userHome();
  const processes = await claudeProcesses(paneId, known);
  const only = processes.length === 1 ? processes[0] : undefined;
  let processDir: string | null = null;
  try {
    processDir = only ? await processClaudeConfigDir(only.pid, only.argv ?? [only.argv0 ?? only.name ?? ""], home) : null;
  } catch (error) {
    // two stores claim the process: ~/.claude would be a guess, maybe another account's session (#586)
    if (error instanceof AmbiguousClaudeStore) throw new ConversationUnavailable("no_session_id");
    throw error;
  }
  const configDir = processDir || defaultClaudeConfigDir(home);
  const attach = only ? await claudeAttachSession(configDir, only.pid, only.argv) : null;
  if (only) onProcess?.(only.pid, attach !== null);
  // the session the process's own PID record names, also beside the hook's: a /branch can leave the hook's behind (#2020);
  // beside a reported session, a record that cannot be read only leaves that session as it was
  const reported = typeof session === "string" && SESSION_ID.test(session);
  const live = attach === null && only
    ? await (reported ? claudeProcessSession(home, only.pid, configDir).catch(() => null) : claudeProcessSession(home, only.pid, configDir))
    : null;
  if (attach !== null) {
    // only the job's state names what the attach shows: a session an earlier Claude in this pane
    // reported through the hook can still be herdr's, and a job with none (a shell command) keeps the terminal
    session = attach.session;
  } else if (!reported) {
    session = live;
  }
  if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
  const path = await claudeTranscriptFile(home, session, cwds, configDir, live);
  // Claude writes the file with its first message: until then the session it reports holds nothing
  if (!path) throw new ConversationNotStarted(session, "claude-transcript");
  return path;
}

/** A Claude pane's transcript and when its Claude process started (null when it cannot be told), or null while it has no transcript. */
export async function claudePaneSession(pane: HerdrPane): Promise<{ path: string; startedAt: number | null; pid: number | null } | null> {
  let pid: number | null = null;
  let attach = false;
  try {
    const path = await claudeTranscriptPath(pane.pane_id, [pane.cwd, pane.foreground_cwd], (found, attached) => { pid = found; attach = attached; });
    // an attach client starts after the job it shows: its start would leave the job's earlier background work lost (#1645)
    return { path, startedAt: pid === null || attach ? null : await processStartedAtAsync(pid), pid };
  } catch (error) {
    if (error instanceof ConversationUnavailable) return null;
    throw error;
  }
}

/**
 * The store holding the omp session herdr reports, or null unless the path is a transcript
 * inside one of the user's own stores: ~/.omp/agent/sessions, or the one `omp --profile <name>`
 * keeps at ~/.omp/profiles/<name>/agent/sessions. A Windows PC reports it in its own form
 * (drive letter, backslashes).
 */
export function ompSessionStore(value: unknown, home: string, paths: PlatformPath = nodePath): string | null {
  if (typeof value !== "string" || !value.endsWith(".jsonl") || !paths.isAbsolute(value) || !paths.isAbsolute(home)) return null;
  const store = paths.join(home, ".omp", "agent", "sessions");
  if (storeRelative(store, value, paths)) return store;
  const profiles = paths.join(home, ".omp", "profiles");
  const parts = storeRelative(profiles, value, paths);
  if (!parts || parts.length < 4 || parts[1] !== "agent" || parts[2] !== "sessions") return null;
  return paths.join(profiles, parts[0]!, "agent", "sessions");
}

/**
 * omp's transcript: herdr hands over the absolute path, accepted only inside the store the pane's
 * omp processes write to (omp.ts ompPaneRoute, from their own argv and environment), as a session
 * of the pane's directory; else the pane's omp process names it. Only where herdr shows no omp
 * process, and on Windows, which shows no process's environment, is herdr's path held to the
 * user's own default and profile stores instead.
 */
/** Where a test stands between a transcript's authorization and its anchor, to change the filesystem then (betweenAuthorizationForTests). */
let betweenAuthorization: ((stage: "before" | "after") => void) | null = null;

/** Lets a test run `between` the authorization of an omp transcript and its blob store's anchor, or stops it (null). */
export function betweenAuthorizationForTests(between: ((stage: "before" | "after") => void) | null): void {
  betweenAuthorization = between;
}

/**
 * An omp transcript as it was authorized (authorizedTranscript: the store's real root and the identity
 * of the very file opened there), with the identity of its blob store taken from those same objects,
 * never from its path walked again: the store root is opened as a directory without following a link
 * and held to be the root named; the path down to the transcript is opened component by component
 * through descriptors, no link followed, and must reach the file authorized; the blob store is then
 * opened beside the held root, by the root's own parent. So nothing swapped above the store, before or
 * after this, can lend another store's identity. Only where a directory can be held and opened through
 * (held-open.ts: Linux, macOS, Windows); elsewhere, and for a layout with no blob store, `blobs` is null
 * and no blob is read.
 */
export function ompAuthorizedTranscript(authorized: { path: string; root: string; identity: string }): { path: string; blobs: string | null } {
  return { path: authorized.path, blobs: heldOpenPlatform(process.platform) ? ompBlobIdentity(authorized) : null };
}

function ompBlobIdentity({ path, root, identity }: { path: string; root: string; identity: string }): string | null {
  const parts = relative(root, path).split(sep);
  // omp's managed store: <data>/sessions/<cwd>/<id>.jsonl, or a subagent's file a level below it
  if (basename(root) !== "sessions" || parts.length < 2 || parts.length > 3) return null;
  const held: Held[] = [];
  const keep = (entry: Held) => { held.push(entry); return entry; };
  try {
    // one descriptor of the agent data directory, opened once and held: the transcript and the blob store
    // are both reached from it, so a directory renamed or moved after this open moves neither
    // the trust boundary: the directory at the data directory's path when it is opened here is the one
    // trusted, as the user's own arrangement then (a process that can rename inside it runs as the user);
    // from this open on, nothing is reached by path again
    betweenAuthorization?.("before");
    const data = keep(openHeldDirectory(dirname(root)));
    if (!data.isAt(dirname(root))) return null;
    betweenAuthorization?.("after");
    let at = keep(data.open("sessions", "directory"));
    for (const [index, name] of parts.entries()) at = keep(at.open(name, index === parts.length - 1 ? "file" : "directory"));
    // the very file authorized, under this data directory's own sessions
    if (at.stat().identity !== identity) return null;
    return keep(data.open("blobs", "directory")).stat().identity;
  } catch { return null; } finally { for (const entry of held) entry.close(); }
}

export async function ompTranscriptPath(paneId: string, cwd: string): Promise<{ path: string; blobs: string | null }> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: unknown; value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  const path = session?.kind === "path" && typeof session.value === "string" ? session.value : null;
  const home = userHome();
  const route = process.platform === "win32" ? null : await ompPaneRoute(paneId);
  // an omp whose store nothing proves, or two keeping different ones
  if (route === "unproved") throw new ConversationUnavailable("no_session_path");
  const store = route === null ? ompSessionStore(path, home) : path === null ? null : ompRouteStore(route, path);
  if (path !== null && store !== null) {
    // omp names its session file at start and writes it with the first answer
    const unwritten = unwrittenSession(path, store);
    if (unwritten !== null) throw new ConversationNotStarted(unwritten.id, "omp-transcript", unwritten.path);
    // the check above is lexical: a link out of the store is no transcript of this pane
    const inStore = authorizedTranscript(path, store);
    if (inStore !== null && (route === null || ompRouteOwns(route, inStore.path, cwd))) return ompAuthorizedTranscript(inStore);
    if (route === null) throw new ConversationUnavailable("no_session_path");
  }
  // herdr names no session of this store (or another agent's): the pane's omp process does
  const held = route === null ? null : ompRouteTranscript(route, cwd);
  if (held === null) throw new ConversationUnavailable("no_session_path");
  // the held transcript is the pane's own, in the store its process keeps: authorized there, and read so
  const authorized = authorizedTranscript(held, route!.layout.sessions);
  return authorized === null ? { path: held, blobs: null } : ompAuthorizedTranscript(authorized);
}

/** A process-owned lifecycle registration, or a trusted report plus a unique held marker. */
async function copilotTranscriptPath(pane: HerdrPane, panes: readonly HerdrPane[], previousClaims?: ReadonlySet<string>, peerInfo?: Map<string, Awaited<ReturnType<typeof paneProcessInfo>> | null>): Promise<{ path: string; binding: string; peerClaims: ReadonlySet<string> }> {
  const report = pane.agent_session;
  // A request shares its peer snapshot across the read; the pane's own process
  // and lifecycle evidence are still validated afresh before returning history.
  // With `peerInfo`, peers' processes come from (and fill) that cache, while their
  // lifecycle logs are read again here, after this pane's own binding.
  let peerClaims: Promise<ReadonlySet<string>> | undefined = previousClaims === undefined ? undefined : Promise.resolve(previousClaims);
  const gatherPeerClaims = async (): Promise<Set<string>> => {
    const claims = new Set<string>();
    for (const peer of panes) {
      if (peer.pane_id === pane.pane_id || peer.agent !== "copilot") continue;
      const cached = peerInfo?.has(peer.pane_id) === true;
      const info = cached ? peerInfo!.get(peer.pane_id) : await paneProcessInfo(peer.pane_id).catch(() => null);
      peerInfo?.set(peer.pane_id, info ?? null);
      const processes = agentProcesses(info?.foreground_processes ?? [], "copilot");
      // A cached peer process that has exited may have been replaced by one we never asked about.
      if (cached && processes.some((entry) => typeof entry.pid === "number" && !processAlive(entry.pid))) throw new ConversationUnavailable("no_session_path", undefined, "copilot_peer_process_replaced");
      if (processes.length === 1 && typeof processes[0]?.pid === "number") {
        const live = copilotProcessSession(processEnviron(processes[0].pid), processes[0].argv ?? [], processes[0].pid);
        if (live?.logged) {
          claims.add(live.sessionId);
          continue;
        }
      }
      if (peer.agent_session?.agent === "copilot" && peer.agent_session.kind === "id" && typeof peer.agent_session.value === "string") claims.add(peer.agent_session.value);
    }
    return claims;
  };
  const claimedByPeer = async (session: string): Promise<boolean> => (await (peerClaims ??= gatherPeerClaims())).has(session);
  if (pane.agent !== "copilot" || (report != null && (report.agent !== "copilot" || report.kind !== "id"
    || report.source !== "herdr:copilot" || typeof report.value !== "string" || !SESSION_ID.test(report.value)))) {
    throw new ConversationUnavailable("no_session_id", undefined, "copilot_report_invalid");
  }
  // A failed RPC does not prove an ownership change. Retry that read once; an answered
  // empty/conflicting process set still fails closed, as does a failed retry.
  const info = await paneProcessInfo(pane.pane_id).catch(() => paneProcessInfo(pane.pane_id)).catch(() => null);
  if (info === null) throw new ConversationUnavailable("no_session_path", undefined, "copilot_process_lookup_failed");
  const processes = agentProcesses(info?.foreground_processes ?? [], "copilot");
  const foreground = processes[0];
  if (process.platform !== "linux" || ![1, 2].includes(processes.length) || typeof foreground?.pid !== "number") {
    throw new ConversationUnavailable("no_session_path", undefined, "copilot_process_set_unproved");
  }
  if (processes.length === 2) {
    if (report == null) throw new ConversationUnavailable("no_session_id", undefined, "copilot_report_invalid");
    const parent = processes[0]!;
    const child = processes[1]!;
    const evidence = (entry: typeof parent) => ({ pid: entry.pid, argv: entry.argv ?? [] });
    const selected = copilotHandoffSession(evidence(parent), evidence(child),
      report.value, info?.foreground_process_group_id, info?.tty, processEnviron)
      ?? copilotHandoffSession(evidence(child), evidence(parent),
        report.value, info?.foreground_process_group_id, info?.tty, processEnviron);
    if (selected?.logged) {
      if (await claimedByPeer(selected.sessionId)) throw new ConversationUnavailable("no_session_path", undefined, "copilot_peer_conflict");
      const path = copilotTranscriptFile(report.value, selected);
      if (path !== null && nodePath.basename(nodePath.dirname(path)) === report.value)
        return { path, binding: selected.generation, peerClaims: await peerClaims! };
    }
    throw new ConversationUnavailable("no_session_path", undefined, "copilot_handoff_unproved");
  }
  const environment = processEnviron(foreground.pid);
  const argv = foreground.argv ?? [];
  const selected = copilotProcessSession(environment, argv, foreground.pid);
  const logged = selected?.logged ? selected : null;
  if (logged !== null && !(await claimedByPeer(logged.sessionId))) {
    const path = copilotTranscriptFile(logged.sessionId, selected);
    if (path !== null && nodePath.basename(nodePath.dirname(path)) === logged.sessionId)
      return { path, binding: `${foreground.pid}:${logged.generation}`, peerClaims: await peerClaims! };
  }
  if (report != null) {
    if (await claimedByPeer(report.value)) throw new ConversationUnavailable("no_session_id", undefined, "copilot_peer_conflict");
    if (logged === null) {
      const path = copilotTranscriptFile(report.value, selected);
      if (path !== null && nodePath.basename(nodePath.dirname(path)) === report.value)
        return { path, binding: `${foreground.pid}:held:${path}`, peerClaims: await peerClaims! };
    }
  }
  const pending = copilotUnwrittenSession(selected, argv);
  if (pending !== null && (report == null || logged?.sessionId === pending.sessionId || report.value === pending.sessionId)
    && !(await claimedByPeer(pending.sessionId))) {
    throw new ConversationNotStarted(pending.sessionId, "copilot-transcript", pending.path);
  }
  throw new ConversationUnavailable(copilotExplicitResume(argv) ? "copilot_resume_unknown" : report == null ? "no_session_id" : "no_session_path",
    undefined, copilotExplicitResume(argv) ? "copilot_resume_unproved" : "copilot_foreground_unproved");
}

/** Where a pane's conversation is: a transcript file, or a session in OpenCode's database. */
type ResolvedTranscript =
  | ({ path: string; codexHome?: string; agy?: AgyStore; piAgentDir?: string | null; ompBlobs?: string | null } & (
    | { source: Exclude<StreamSource, "copilot-transcript"> }
    | { source: "copilot-transcript"; binding: string; peerClaims: ReadonlySet<string> }
  ))
  | { source: "opencode-transcript"; path: string; session: string }
  | { source: "hermes-transcript"; path: string; sessionId: string };

/** A native file or database session, resolved without parsing conversation turns. */
export type NativeTranscript =
  | ResolvedTranscript
  | { source: "devin-transcript"; path: string; session: string; cwd: string };

/**
 * The store a pane's transcript lives in. herdr's agent label follows the
 * pane's foreground processes, so an omo pane reads as `pi` while it waits and
 * as `claude` while its claude-sdk child runs (live-verified 2026-09-21) — the
 * label alone cannot route omo. Its process tree takes precedence over the child
 * label: omo's own store is read only when omo is really running
 * in that pane, never on a matching cwd alone.
 */
async function resolveTranscript(pane: HerdrPane, cwd: string, codexHome?: string, panes?: HerdrPane[], opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string, known?: KnownProcesses): Promise<ResolvedTranscript> {
  const paneId = pane.pane_id;
  let agent = resolveAgent(pane).agent ?? "";
  // herdr names no agent for this pane: a session report an earlier agent left behind says
  // nothing about what runs now, so the pane's processes are asked before it is followed.
  // A pane herdr does label is not asked: the lookup would cost every transcript lookup an RPC (and
  // a process-table read on Windows), and a gjc below another agent would take its chat.
  if (!pane.agent) {
    const info = known !== undefined ? { process_info: known ?? undefined } : await herdrRpc<{ process_info?: { shell_pid?: number; foreground_processes?: { argv?: unknown }[] } }>(
      "pane.process_info", { pane_id: paneId },
    ).catch(() => null);
    const running = (info?.process_info?.foreground_processes ?? []).some((process) =>
      isGjcProcess(Array.isArray(process.argv) ? process.argv.map(String) : []),
    );
    if (running || await gjcPidUnderShell(info?.process_info?.shell_pid)) agent = "gjc";
  }
  // a Muse or Letta pane's processes are asked for once, for omo and for its own binding
  if ((agent === "muse" || agent === "letta") && known === undefined) known = (await paneProcessInfo(paneId).catch(() => undefined)) ?? null;
  if (await paneRunsOmo(paneId, known)) {
    return { source: "omo-transcript", path: await omoTranscriptPath(paneId, cwd, panes) };
  }
  // omp and GJC can change their own cwd without changing the pane's shell directory; their
  // session headers name the one they run in
  const sessionCwd = typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0 ? pane.foreground_cwd : cwd;
  try {
    if (agent === "copilot") return { source: "copilot-transcript", ...await copilotTranscriptPath(pane, panes ?? [pane]) };
    if (agent === "grok") {
      const found = await resolveGrokStore(pane, grokHome);
      if (!found) throw new ConversationUnavailable("no_session_path");
      return { source: "grok-transcript", path: found };
    }
    if (agent === "muse") {
      const path = await resolveMuseSession(pane, museData, known);
      if (path === null) throw new ConversationUnavailable("no_session_path");
      return { source: "muse-transcript", path };
    }
    // herdr's label, not a report an earlier Letta left behind: the binding needs a running one
    if (agent === "letta" && pane.agent === "letta") {
      // no file yet is no proof the conversation has no turns (one begun elsewhere): Terminal stands in
      const found = await resolveLettaTranscript(pane, panes ?? [pane], known);
      if (found === null) throw new ConversationUnavailable("no_session_path");
      return { source: "letta-transcript", path: found.path };
    }
    if (agent === "agy") {
      const found = await resolveAgyStore(pane);
      if (!found) throw new ConversationUnavailable("no_session_path");
      let transcriptExists: boolean;
      try { transcriptExists = !!statSync(found.path, { throwIfNoEntry: false }); }
      catch { throw new ConversationUnavailable("transcript_missing"); }
      if (!transcriptExists) {
        if (agyCatalog(found.path).size !== 0 || !sameAgyStore(found, await resolveAgyStore(pane))) throw new ConversationUnavailable("transcript_missing");
        throw new ConversationNotStarted(found.session, "agy-transcript", found.path);
      }
      return { source: "agy-transcript", path: found.path, agy: found };
    }
    if (agent === "codex") {
      // the pane's own store: the rollout, its history and its images are all read from there
      const home = await paneCodexHome(paneId, codexHome);
      const path = await codexTranscriptPath(paneId, cwd, home, panes);
      if (!path) throw new ConversationUnavailable("no_session_path");
      return { source: "codex-transcript", path, codexHome: home };
    }
    // Claude's project is the directory it started in, the process's own cwd more often than the pane's
    if (agent === "claude") {
      const path = await claudeTranscriptPath(paneId, [cwd, pane.foreground_cwd], undefined, known);
      return { source: "claude-transcript", path };
    }
    if (agent === "omp") {
      const authorized = await ompTranscriptPath(paneId, sessionCwd);
      return { source: "omp-transcript", path: authorized.path, ompBlobs: authorized.blobs };
    }
    if (agent === "gjc") return { source: "gjc-transcript", path: await gjcTranscriptPath(paneId, sessionCwd) };
    // pi's own label only routes pi: an omo pane was taken above, by its process tree.
    if (agent === "pi") {
      const found = await piTranscriptPath(paneId, undefined, known === undefined ? {} : { processes: known?.foreground_processes ?? [] });
      if (found === null) throw new ConversationUnavailable("no_session_path");
      if ("unwritten" in found) throw new ConversationNotStarted(found.unwritten.id, "pi-transcript", found.unwritten.path);
      return { source: "pi-transcript", path: found.path, piAgentDir: found.agentDir };
    }
    if (agent === "cmd") {
      const found = await cmdTranscriptPath(paneId);
      if (found === null) throw new ConversationUnavailable("no_session_path");
      if ("unwritten" in found) throw new ConversationNotStarted(found.unwritten.id, "cmd-transcript", found.unwritten.path);
      return { source: "cmd-transcript", path: found.path };
    }
    if (agent === "opencode") {
      // herdr's integration names the session the TUI shows; at its home screen there is none
      const session = opencodeSessionId(pane);
      if (session === null) throw new ConversationUnavailable("no_session_id");
      const path = opencodeDb ?? opencodeDatabasePath();
      if (path === null) throw new ConversationUnavailable("no_session_path");
      return { source: "opencode-transcript", path, session };
    }
    if (agent === "hermes") {
      const resolved = await hermesTranscriptForPane(pane, cwd, hermesHome);
      return { source: "hermes-transcript", path: resolved.dbPath, sessionId: resolved.sessionId };
    }
    throw new ConversationUnavailable("no_recognized_transcript");
  } catch (error) {
    if (error instanceof AgyUnavailable) throw new ConversationUnavailable("transcript_missing");
    if (!(error instanceof ConversationUnavailable) || !(await paneRunsOmo(paneId, known))) throw error;
    return { source: "omo-transcript", path: await omoTranscriptPath(paneId, cwd, panes) };
  }
}

async function omoTranscriptPath(paneId: string, cwd: string, panes?: HerdrPane[]): Promise<string> {
  const session = await omoSessionForPane(paneId, cwd, panes ?? (await sessionSnapshot()).panes);
  if (session.pending !== null) throw new ConversationNotStarted(session.pending);
  if (!session.path) throw new ConversationUnavailable("no_session_path");
  return session.path;
}

/**
 * Resolve the native live file or database session without reading conversation turns. `known`: herdr's
 * `pane.process_info` for this pane that the caller read for this same look, so it is not asked again.
 */
export async function paneTranscript(paneId: string, codexHome?: string, snapshot?: SessionSnapshot, devinDbPath?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string, known?: KnownProcesses): Promise<NativeTranscript> {
  const panes = (snapshot ?? await sessionSnapshot()).panes;
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined) throw new ConversationUnavailable("pane_not_found");
  // an agent pane without a folder is a failure to diagnose, not a shell's expected scrollback
  if (typeof pane.cwd !== "string" || pane.cwd.length === 0) throw new ConversationUnavailable("no_recognized_transcript", undefined, pane.agent ? "agent_cwd_missing" : undefined);

  if (pane.agent === "devin" && !(await paneRunsOmo(paneId, known))) {
    const cwd = pane.foreground_cwd || pane.cwd;
    const storePath = devinDbPath ?? defaultDevinDbPath();
    const info = known !== undefined ? { process_info: known ?? undefined } : await herdrRpc<{ process_info?: { foreground_processes?: { argv?: unknown }[] } }>(
      "pane.process_info", { pane_id: paneId },
    ).catch(() => null);
    const processes = (info?.process_info?.foreground_processes ?? []).filter((process) =>
      Array.isArray(process.argv) && process.argv.every((arg) => typeof arg === "string") &&
      isDevinProcess(process.argv as string[]) && process.argv[1] !== "acp",
    );
    if (processes.length > 1) throw new ConversationUnavailable("transcript_missing");
    // No Devin runs under the label: what does run is resolved below, as it was before this
    // reader (an omo is found by its process tree, whatever herdr calls the pane).
    if (processes.length === 1) {
      const session = devinSessionForPane(pane, panes, processes[0]!.argv as string[]);
      return { source: "devin-transcript", path: storePath, session, cwd };
    }
  }

  return resolveTranscript(pane, pane.cwd, codexHome, panes, opencodeDb, hermesHome, grokHome, museData, known);
}

/**
 * The pane's live screen, or "" when nothing proves it: herdr's viewport, read while herdr reports
 * it at the bottom with the same history before and after the read. Scrolled up, on this device or
 * another, the viewport is history; and herdr's detection read is no stand-in, since on a short
 * screen it reaches up into the history above (herdr 0.9.5: a cleared 7-row screen read as 34 rows).
 * Whatever the agent drew there before (another model, a conversation) is not what it shows now.
 * A scroll herdr does not report, or a lookup that fails, proves nothing either: pane.get then gives
 * no geometry, and a viewport scrolled up into the blank rows under a short screen reads the same
 * as the live one, so no screen is read rather than guessed (unlike viewportShowsLive's text check).
 */
async function bottomViewport(paneId: string): Promise<string> {
  const scroll = () => paneScrollInfo(paneId).catch(() => null);
  const before = await scroll();
  if (before?.offset_from_bottom !== 0) return "";
  const text = await paneRead({ paneId, source: "visible", format: "text", timeoutMs: 2_000 }).then((read) => read.text, () => "");
  const after = text === "" ? null : await scroll();
  return after?.offset_from_bottom === 0 && after.max_offset_from_bottom === before.max_offset_from_bottom ? text : "";
}

/**
 * pane -> agent session -> transcript turns. Read-only, same-user files only.
 * Claude sessions are looked up by id under ~/.claude/projects; omp sessions
 * come from herdr or the pane's omp process (ompTranscriptPath); omo sessions are resolved from its own store by
 * process/session evidence (omoTranscriptForPane). Throws ConversationUnavailable when the pane has
 * no recognized agent store (the caller falls back to the scrollback
 * transcript view, like chatmux).
 *
 * Without `page` this is the newest page. `before` is the page ending at a
 * returned cursor; `from` is every turn after one, for a chat that already
 * shows the pages before it. A cursor from another file throws HistoryChanged.
 * `opencodeDb` is OpenCode's store, unset where OpenCode itself would find it.
 */
export async function paneConversation(paneId: string, codexHome?: string, page: ConversationPage = {}, devinDbPath?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string): Promise<RecognizedConversation> {
  const snapshot = await sessionSnapshot();
  let resolved: NativeTranscript;

  // no transcript states the model yet: the agent's own screen does (start-screen.ts). A screen
  // that cannot be read leaves it unknown. omp follows its transcript only: catalog discovery
  // can refresh the CLI's OAuth credentials and is never initiated by the bridge. Only the live
  // screen counts (bottomViewport): history can show an older frame of the agent, with a model it
  // no longer runs.
  const screenMetadata = async (source: RecognizedConversation["source"]): Promise<ConversationMetadata> =>
    startScreenMetadata(source, await bottomViewport(paneId));
  const notBegun = async (source: RecognizedConversation["source"], id: string, read?: ConversationMetadata): Promise<RecognizedConversation> => {
    // what the screen states can change with the pane's output, with no file to watch: the chat re-reads on it
    const screen = readsStartScreen(source);
    const metadata = read ?? (screen ? await screenMetadata(source) : { model: null, reasoning_effort: null });
    return { source, turns: [], metadata, ...(screen ? { screen: true as const } : {}), cursor: null, history_id: id, version: answerVersion(id, `${metadata.model}\0${metadata.reasoning_effort}`) };
  };

  const onNotStarted = (error: ConversationNotStarted): Promise<RecognizedConversation> => {
    // a file read before and gone since is no conversation not begun: the terminal stands in for it
    if (writtenSessions.has(`${error.source}\0${error.identity}`)) throw new ConversationUnavailable("transcript_missing");
    // nothing comes before a conversation not begun: a cursor into it is another one's
    if (page.before !== undefined || page.since !== undefined || page.from !== undefined) throw new HistoryChanged();
    // an agent at work on its first turn has written nothing yet, but its terminal shows the turn
    const status = snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
    if (status === "working" || status === "blocked") throw error;
    // the chat says there is nothing yet; the session's first prompt writes the file and
    // the next refresh's history_id differs, so the chat takes it whole
    return notBegun(error.source, `unwritten:${error.sessionId}`);
  };

  try {
    resolved = await paneTranscript(paneId, codexHome, snapshot, devinDbPath, opencodeDb, hermesHome, grokHome, museData);
    launchedAgents.forget(paneId);
  } catch (error) {
    if (error instanceof ConversationNotStarted) { launchedAgents.forget(paneId); return await onNotStarted(error); }
    if (!(error instanceof ConversationUnavailable)) throw error;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (pane === undefined) { launchedAgents.forget(paneId); throw error; }
    if (pane.agent === "copilot" && (page.before !== undefined || page.since !== undefined || page.from !== undefined)) throw new HistoryChanged();
    if (pane.agent === "copilot") throw error;
    // an agent this server started writes no session before its first message (launched-agents.ts)
    const launch = launchedAgents.notBegun(paneId, pane.agent_status);
    if (launch === null) {
      // a Codex that reported no session yet (one started in the terminal): the terminal stands in
      // for the chat, and Codex's live status line still states the model and effort it runs at
      if (pane.agent === "codex" && page.before === undefined && page.since === undefined && page.from === undefined) {
        const text = await bottomViewport(paneId);
        const screen = startScreenMetadata("codex-transcript", text);
        // unless it has begun no conversation at all: then it has its greeting, as one this server
        // started does. At work or asking, its first turn may have begun.
        if (error.message === "no_session_path" && screen.model !== null && pane.agent_status !== "working" && pane.agent_status !== "blocked") {
          // every folder the pane names, and the screen this was decided on
          const fresh = await codexFreshSession(paneId, [pane.cwd ?? "", pane.foreground_cwd ?? ""], codexHome, text);
          if (fresh !== null) return await notBegun("codex-transcript", fresh, screen);
        }
        if (screen.model !== null) throw new ConversationUnavailable(error.message, screen);
      }
      throw error;
    }
    if (page.before !== undefined || page.since !== undefined || page.from !== undefined) throw new HistoryChanged();
    return await notBegun(launch.source, launch.historyId);
  }
  if (resolved.source === "devin-transcript") {
    try {
      const answer = devinConversation(resolved.session, resolved.cwd, page, resolved.path);
      rememberPaneDevin(paneId, resolved.session, resolved.cwd, resolved.path);
      return answer;
    } catch (error) {
      if (error instanceof DevinHistoryUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  if (resolved.source === "opencode-transcript") {
    // its caches are keyed by store and session, which is what the pane is remembered against
    rememberPaneRead(paneId, opencodeReadKey(resolved.path, resolved.session));
    const answer = opencodeConversation(resolved.path, resolved.session, page);
    if (answer.kind === "history_changed") throw new HistoryChanged();
    if (answer.kind === "unavailable") throw new ConversationUnavailable(answer.reason);
    const { kind: _kind, signature, ...conversation } = answer;
    const key = `opencode\0${resolved.path}\0${resolved.session}\0${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}\0${page.prompts ?? ""}`;
    return { source: resolved.source, ...conversation, version: answerVersion(key, signature) };
  }
  if (resolved.source === "hermes-transcript") {
    rememberPaneRead(paneId, resolved.path);
    try {
      const answer = hermesConversationPage(resolved.sessionId, resolved.path, page);
      writtenSessions.add(`${resolved.source}\0${resolved.sessionId}`);
      rememberPaneSession(paneId, `${resolved.source}\0${resolved.sessionId}`);
      return answer;
    } catch (error) {
      if (error instanceof ConversationNotStarted) return await onNotStarted(error);
      throw error;
    }
  }
  const identity = resolved.source === "agy-transcript" || resolved.source === "copilot-transcript" || resolved.source === "letta-transcript" ? resolved.path
    : resolved.source === "claude-transcript" ? nodePath.basename(resolved.path, ".jsonl")
    : resolved.source === "pi-transcript" || resolved.source === "cmd-transcript" || resolved.source === "omp-transcript" ? realpathSync(resolved.path) : null;
  rememberPaneRead(paneId, resolved.path);
  const history = resolved.source === "copilot-transcript" ? copilotHistoryIdentity(resolved.path) : null;
  const prefix = history !== null && resolved.source === "copilot-transcript" ? copilotPrefix(paneId, `${resolved.binding}\0${history}`) : null;
  let answer: RecognizedConversation;
  try {
    answer = transcriptPage(resolved.source, resolved.path, prefix === null ? page : copilotPage(page, prefix), resolved.codexHome ?? codexHome, resolved.piAgentDir);
  } catch (error) {
    if (resolved.source !== "copilot-transcript" || prefix === null || !(error instanceof ConversationUnavailable) || error.message !== "transcript_missing") throw error;
    const paged = page.before !== undefined || page.since !== undefined || page.from !== undefined;
    // Unpaged refreshes otherwise carry no proof of which history is on screen: older
    // clients without it keep their fail-closed fallback, with no recheck to wait on.
    if (page.history_id === undefined && !paged) throw error;
    // A read failure is not an empty conversation. Only a fresh, matching binding
    // and file generation permit retaining the view; never reuse the request's earlier peer claims.
    try {
      const fresh = await sessionSnapshot();
      const pane = fresh.panes.find((candidate) => candidate.pane_id === paneId);
      if (pane === undefined) throw new ConversationUnavailable("no_session_id");
      // Peer checks await herdr, and either side can switch meanwhile: once every
      // process is known, read this pane's binding and the peers' claims again with no
      // herdr call between those reads and the comparison.
      const peerInfo = new Map<string, Awaited<ReturnType<typeof paneProcessInfo>> | null>();
      await copilotTranscriptPath(pane, fresh.panes, undefined, peerInfo);
      const current = await copilotTranscriptPath(pane, fresh.panes, undefined, peerInfo);
      if (current.path !== resolved.path || current.binding !== resolved.binding || copilotHistoryIdentity(resolved.path) !== history) {
        throw new ConversationUnavailable("no_session_path");
      }
    } catch (cause) {
      if (cause instanceof ConversationUnavailable && paged) throw new HistoryChanged();
      throw cause;
    }
    if (page.history_id !== undefined && !page.history_id.startsWith(prefix)) throw new HistoryChanged();
    throw new ConversationReadPending();
  }
  const status = snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
  if (resolved.source === "grok-transcript" && answer.turns.length === 0 && page.before === undefined
    && (status === "working" || status === "blocked")) {
    // the file can change or go between the page and this check: either way the terminal answers
    let revision: string | null = null;
    try { revision = grokProjection(resolved.path, statSync(resolved.path)).revision; } catch { /* unreadable now */ }
    if (revision === null || revision === "0") throw new ConversationUnavailable("transcript_missing");
  }
  if (resolved.agy && !sameAgyStore(resolved.agy, await resolveAgyStore(snapshot.panes.find((pane) => pane.pane_id === paneId)!))) throw new ConversationUnavailable("no_session_path");
  if (identity !== null) { writtenSessions.add(`${resolved.source}\0${identity}`); rememberPaneSession(paneId, `${resolved.source}\0${identity}`); }
  if (resolved.source === "claude-transcript" && identity !== null && answer.metadata.context) {
    const window = readStatuslineContext(userHome(), identity, answer.metadata.model);
    if (window !== null) return {
      ...answer,
      metadata: { ...answer.metadata, context: { ...answer.metadata.context, window } },
      // A statusline capture can change without a transcript append.
      version: answerVersion(answer.version, String(window)),
    };
  }
  if (resolved.source === "cmd-transcript") {
    // The pane's current model can change without a transcript append. Enrich a response,
    // never the shared transcript page, and include the live model in its ETag.
    const herdrAgent = snapshot.agents.find((agent) => agent.pane_id === paneId);
    const model = typeof herdrAgent?.tokens?.model === "string" ? herdrAgent.tokens.model : null;
    if (model) return {
      ...answer,
      metadata: { ...answer.metadata, model },
      version: answerVersion(answer.version, model),
    };
  }
  if (resolved.source === "grok-transcript") {
    try { return { ...answer, activity: grokProjection(resolved.path, statSync(resolved.path)).activity }; }
    catch { throw new ConversationUnavailable("transcript_missing"); }
  }
  if (prefix !== null && resolved.source === "copilot-transcript") {
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId)!;
    const current = await copilotTranscriptPath(pane, snapshot.panes, resolved.peerClaims);
    if (current.path !== resolved.path || current.binding !== resolved.binding
      || copilotHistoryIdentity(resolved.path) !== history) throw new HistoryChanged();
    return bindCopilotAnswer(answer, prefix);
  }
  return answer;
}

/**
 * Command evidence needs native control records that the conversation deliberately hides.
 * Reuse its pane binding, but resolve evidence and pi ancestry from one bounded tail only.
 * Database agents are observed through their readers/native events, never guessed from turns.
 */
interface CommandTranscript {
  readonly identity: string;
  readonly records: readonly CommandTranscriptRecord[];
}
/**
 * A command transcript's window starts at a multiple of this, and the window read is remembered by a digest of each
 * such chunk instead of its bytes: the next read checks every byte the two share against them (sameOverlap).
 */
const WINDOW_CHUNK_BYTES = 64 * 1024;
/** Where the window of a transcript of `size` bytes starts: the first chunk boundary it fits after (at most the budget). */
const windowStart = (size: number): number => size <= TRANSCRIPT_WINDOW_BYTES ? 0
  : Math.ceil((size - TRANSCRIPT_WINDOW_BYTES) / WINDOW_CHUNK_BYTES) * WINDOW_CHUNK_BYTES;
/** A digest of each chunk of a window read at a chunk boundary, the last one as far as the read goes. */
function chunkDigests(bytes: Buffer): BigUint64Array {
  const digests = new BigUint64Array(Math.ceil(bytes.length / WINDOW_CHUNK_BYTES));
  for (let index = 0; index < digests.length; index++) {
    digests[index] = BigInt(Bun.hash.xxHash3(bytes.subarray(index * WINDOW_CHUNK_BYTES, (index + 1) * WINDOW_CHUNK_BYTES)));
  }
  return digests;
}
/**
 * Whether the window read now at `start` (`bytes`, `digests`) holds what the one read before held up to its end, byte
 * for byte as far as the digests tell: each chunk both hold, the earlier read's last one as far as that read went.
 */
function sameOverlap(before: { start: number; end: number; digests: BigUint64Array }, start: number, bytes: Buffer, digests: BigUint64Array): boolean {
  for (let at = start; at < before.end; at += WINDOW_CHUNK_BYTES) {
    const end = Math.min(at + WINDOW_CHUNK_BYTES, before.end);
    const now = end - at === WINDOW_CHUNK_BYTES ? digests[(at - start) / WINDOW_CHUNK_BYTES]
      : BigInt(Bun.hash.xxHash3(bytes.subarray(at - start, end - start)));
    if (before.digests[(at - before.start) / WINDOW_CHUNK_BYTES] !== now) return false;
  }
  return true;
}
const commandTranscripts = new Map<string, {
  signature: string; file: string; start: number; end: number; digests: BigUint64Array;
  partialStart: number; records: CommandTranscriptRecord[]; identity: string;
  /** pi: the active branch's name and its last node, which an append that runs on from it keeps */
  branch: string; leaf: string | null; answer: CommandTranscript | null;
  /** pi: the last node each recent branch was read at (id and byte offset), newest last, so a session that comes back
   * to one keeps its name */
  branches: Map<string, { id: string; offset: number }>;
}>();
const REMEMBERED_BRANCHES = 8;

/** `look`: the snapshot and herdr's `pane.process_info` the caller's poll already read, so neither is asked again. */
export async function readCommandTranscript(paneId: string, codexHome?: string, look: { snapshot?: SessionSnapshot; processes?: KnownProcesses } = {}): Promise<CommandTranscript | null> {
  const resolved = await paneTranscript(paneId, codexHome, look.snapshot, undefined, undefined, undefined, undefined, undefined, look.processes);
  const { source, path } = resolved;
  if (source !== "claude-transcript" && source !== "codex-transcript" && source !== "pi-transcript"
    && source !== "omp-transcript" && source !== "omo-transcript" && source !== "gjc-transcript") return null;
  const stat = statSync(path);
  const file = `${source}:${stat.dev}:${stat.ino}`;
  const signature = `${source}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = commandTranscripts.get(path);
  rememberPaneRead(paneId, path);
  if (cached?.signature === signature) return cached.answer;
  // Do not call transcriptStream here: building a cold pi index can read the entire file.
  // The same read supplies validation bytes AND new bytes, so their total stays in budget.
  // Every byte is read over (a short read gives up), so it need not be zeroed first.
  const start = windowStart(stat.size);
  const bytes = Buffer.allocUnsafe(stat.size - start);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length) return null;
  } finally { closeSync(fd); }
  let from = start;
  if (start > 0) {
    const newline = bytes.indexOf(0x0a);
    from += newline < 0 ? bytes.length : newline + 1;
  }
  // an append only when every byte both reads hold is the same, told by chunk digests: the window's bytes are not
  // kept between reads (#1487)
  const digests = chunkDigests(bytes);
  const append = cached?.file === file && stat.size > cached.end && start < cached.end
    && cached.partialStart >= from && sameOverlap(cached, start, bytes, digests);
  const readFrom = append ? cached.partialStart : from;
  const partialStart = Math.max(from, start + bytes.lastIndexOf(0x0a) + 1);
  const records = [
    ...(append ? cached.records.filter(record => record.offset >= from) : []),
    ...commandTranscriptRecords(bytes.subarray(readFrom - start, partialStart - start).toString("utf8"), readFrom),
  ];
  // A complete JSON object without its newline is visible, but never retained twice on append.
  let current = [...records, ...commandTranscriptRecords(bytes.subarray(partialStart - start).toString("utf8"), partialStart)];
  const identity = append ? cached.identity : `${source}\0${path}\0${file}:${stat.size}:${stat.mtimeMs}`;
  let branch = "";
  let leaf: string | null = null;
  let branches = new Map<string, { id: string; offset: number }>();
  if (source === "pi-transcript") {
    const nodes = current.filter(record => typeof record.entry.id === "string");
    const byId = new Map(nodes.map((record, index) => [String(record.entry.id), { record, index }]));
    const active: CommandTranscriptRecord[] = [];
    const forks: CommandTranscriptRecord[] = [];
    let node = nodes.length ? byId.get(String(nodes[nodes.length - 1]!.entry.id)) : undefined;
    let rooted = false;
    while (node && byId.size === nodes.length) {
      const { record, index } = node;
      active.push(record);
      const parentId = record.entry.parentId;
      if (parentId === null) {
        forks.push(record); rooted = true; break;
      }
      if (nodes[index - 1]?.entry.id !== parentId) forks.push(record);
      const parent = typeof parentId === "string" ? byId.get(parentId) : undefined;
      // In append-only pi histories, ancestors beyond a cut window precede its active path.
      if (!parent && typeof parentId === "string" && start > 0) { rooted = true; break; }
      if (!parent || parent.record.offset >= record.offset) break;
      node = parent;
    }
    // An unexplained missing ancestor or ambiguous index cannot prove branch ownership.
    current = rooted ? active.reverse() : [];
    leaf = rooted && current.length > 0 ? String(current.at(-1)!.entry.id) : null;
    // An append that runs on from the node a branch was last read at is that branch: the forks in the window change
    // as it slides (its first node always looks like one), and the session can go to another branch and /tree back,
    // yet the sends bound to the branch must keep seeing it (#1487, #1879). Any other path names its branch afresh.
    if (append) branches = new Map(cached.branches);
    const resumed = rooted ? resumedBranch(branches, nodes, current) : null;
    const continued = resumed === null && append && cached.leaf !== null && cached.branch !== "unresolved" && rooted
      && runsOnFromCut(cached.leaf, current, forks, nodes[0]);
    branch = !rooted ? "unresolved" : resumed ?? (continued ? cached.branch
      : createHash("sha256").update(forks.map(({ entry }) => String(entry.id)).join("\0")).digest("hex"));
    if (branch !== "unresolved" && leaf !== null) {
      branches.delete(branch);
      branches.set(branch, { id: leaf, offset: current.at(-1)!.offset });
      if (branches.size > REMEMBERED_BRANCHES) branches.delete(branches.keys().next().value!);
    }
  }
  const cleared = current.reduce((last, { entry }, index) => isContextClear(entry, source) ? index : last, 0);
  const answer = branch === "unresolved" ? null
    : { identity: `${identity}\0${branch}`, records: cleared > 0 ? current.slice(cleared) : current };
  remember(commandTranscripts, path, { signature, file, start, end: stat.size, digests, partialStart, records, identity, branch, leaf, answer, branches }, 4);
  return answer;
}

/**
 * The remembered pi branch (`branches`: name to the node it was last read at) that `path` runs on from. Its node is on
 * the path, the same entry at the same offset (a later entry may reuse its id), and of what was written since (that node was then the file's last), nothing off the path is under it, and
 * nothing off the path is a record a send's result could be (`PI_EVIDENCE_TYPES`): a result written on the branch the
 * session went to must not leave a send waiting on its old branch for a later identical send's. `nodes` are the
 * window's nodes in file order.
 */
function resumedBranch(branches: ReadonlyMap<string, { id: string; offset: number }>, nodes: readonly CommandTranscriptRecord[], path: readonly CommandTranscriptRecord[]): string | null {
  const onPath = new Map(path.map((record) => [String(record.entry.id), record]));
  for (const [name, leaf] of branches) {
    const at = onPath.get(leaf.id);
    if (!at || at.offset !== leaf.offset) continue;
    const under = new Set([leaf.id]);
    const alone = nodes.every(({ entry, offset }) => {
      if (offset <= at.offset) return true;
      const id = String(entry.id);
      if (typeof entry.parentId === "string" && under.has(entry.parentId)) {
        under.add(id);
        return onPath.has(id);
      }
      return onPath.has(id) || !PI_EVIDENCE_TYPES.has(String(entry.type));
    });
    if (alone) return name;
  }
  return null;
}

/**
 * Whether a pi path read after an append runs on from `leaf`, the last node of the path read before, which was cut
 * away with the window's start: it is the parent of the path's first node (the first node read after it, as appends
 * follow it), whose own fork mark only says its predecessor was cut away, and no other fork follows.
 */
function runsOnFromCut(leaf: string, path: readonly CommandTranscriptRecord[], forks: readonly CommandTranscriptRecord[], first: CommandTranscriptRecord | undefined): boolean {
  const head = path[0];
  return head !== undefined && head === first && head.entry.parentId === leaf && forks.every((fork) => fork === head);
}

/**
 * One page of a resolved transcript (paneConversation's `page`). `piAgentDir` is the pane's pi
 * agent directory, whose catalogs state a pi model's context window (parseConversationMetadata).
 */
export function transcriptPage(source: StreamSource, path: string, page: ConversationPage = {}, codexHome?: string, piAgentDir?: string | null): RecognizedConversation {
  if (source === "copilot-transcript") {
    let fd: number;
    try { fd = openCopilotFile(path); }
    catch { throw new ConversationUnavailable("transcript_missing"); }
    try { return transcriptPageRead(source, path, page, codexHome, undefined, fd, piAgentDir); }
    finally { closeSync(fd); }
  }
  if (source === "agy-transcript") {
    try { return withAgyHistory(path, (projection, fd) => ({ ...transcriptPageRead(source, path, page, codexHome, projection, fd), activity: projection.activity })); }
    catch (error) {
      if (error instanceof HistoryChanged || error instanceof ConversationUnavailable) throw error;
      throw new ConversationUnavailable("transcript_missing");
    }
  }
  return transcriptPageRead(source, path, page, codexHome, undefined, undefined, piAgentDir);
}

function transcriptPageRead(source: StreamSource, path: string, page: ConversationPage, codexHome?: string, agy?: AgyProjection, fd?: number, piAgentDir?: string | null): RecognizedConversation {
  let stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  try {
    stat = statSync(path);
    if (fd !== undefined) {
      const pinned = fstatSync(fd);
      if (pinned.dev !== stat.dev || pinned.ino !== stat.ino || pinned.size !== stat.size) throw new ConversationUnavailable("transcript_missing");
    }
  } catch {
    throw new ConversationUnavailable("transcript_missing");
  }
  let stream: TranscriptStream;
  try {
    stream = transcriptStream(source, path, stat, codexHome ?? defaultCodexHome(), agy, fd);
    applyHistoryBoundary(path, stream, source);
  } catch (error) {
    // a branch that cannot be walked says so; a file that went unreadable mid-read has
    // one answer, and an unreadable branch has its own
    if (error instanceof ConversationUnavailable) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }
  // an older page never changes while its file and the rollouts before it stay the same
  // (the stream's id names both); the newest one changes with every append
  // the page size decides which bytes a page starts at: it belongs in the key
  const key = page.before !== undefined
    ? `${path}\0before:${page.before}:${page.since ?? ""}:${pagePrompts(page)}`
    : `${path}\0from:${page.from ?? ""}:${pagePrompts(page)}`;
  // the catalogs a pi window is read from are the pane's: another pane's answer is not this one's
  const catalogs = piAgentDir === undefined ? "" : `:${piAgentDir}`;
  const signature = page.before !== undefined ? `${stream.id}${catalogs}` : `${stream.id}:${stream.length}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}${catalogs}`;
  const cached = cache.get(key);
  // the answer is a function of the page asked for and the file's state, so they name it
  const version = answerVersion(key, signature);
  if (cached?.signature === signature) {
    return { source, turns: cached.turns, metadata: cached.metadata, cursor: cached.cursor, abandoned: cached.abandoned, history_id: stream.id, version };
  }

  let start: number;
  let text: string;
  let head = "";
  let cursor: string | null;
  let live: { turns: ConversationTurn[]; metadata: ConversationMetadata } | null = null;
  try {
    if (page.before !== undefined) {
      const before = parseCursor(stream, page.before);
      const floor = page.since === undefined ? stream.floor : parseCursor(stream, page.since);
      if (floor > before) throw new HistoryChanged();
      const older = before === floor ? { start: floor, bytes: Buffer.alloc(0) } : pageBefore(stream, source, before, { floor, widen: true, prompts: pagePrompts(page) });
      start = older.start;
      text = older.bytes.toString("utf8");
    } else {
      const held = page.from === undefined ? null : parseCursor(stream, page.from);
      const newest = newestPage(path, stream, source, pagePrompts(page));
      // A chat that shows older pages holds the start of its newest turns and keeps
      // every turn after it while they are inside the newest page. Once the newest
      // page has moved past it, the chat gets the newest page and fetches the turns
      // in between with `before` + `since`: no poll reads more than a page.
      if (newest !== null) {
        start = held !== null && held >= newest.start ? held : newest.start;
        live = liveTurns(path, stream, source, start, newest.starts, piAgentDir);
        text = "";
      } else {
        // no turn starts in the window: the page begins mid-turn, read whole as before
        const whole = pageBefore(stream, source, stream.length, { widen: false, prompts: pagePrompts(page) });
        start = held !== null && held >= whole.start ? held : whole.start;
        text = whole.bytes.subarray(start - whole.start).toString("utf8");
      }
    }
    if (live === null && page.before === undefined && start > stream.floor) head = metadataHead(path, stream, source, start);
    cursor = formatCursor(stream, start);
  } catch (error) {
    if (error instanceof HistoryChanged || error instanceof ConversationUnavailable) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }

  // the store decides the parser, not the pane's label: omo writes omp's
  // session shape while herdr may be calling that same pane `claude`. The page
  // bounds the turns, so none are cut: they must meet the next page exactly.
  const turns = live?.turns ?? parseTurns(source, path, text, undefined, undefined, start);
  const metadata = live?.metadata ?? parseConversationMetadata(`${head}\n${text}`, source, undefined, piAgentDir);
  // Record the stat from BEFORE the read: an append during parsing must cause
  // another read on the next poll, not permanently cache a torn tail.
  cache.delete(key);
  // the abandoned turns live outside the branch's byte ranges, so the page cannot see them: a
  // straight line answers { count: 0 }, which is most sessions and costs the client nothing
  const abandoned = (source === "pi-transcript" || source === "cmd-transcript") ? piAbandonedTurns(path, stat.size) ?? undefined : undefined;
  rememberPage(cache, key, { source, signature, turns, metadata, cursor, abandoned }, 32);
  return { source, turns, metadata, cursor, abandoned, history_id: stream.id, version };
}

/**
 * One image in a pane's conversation, by the ref its part carries: for Claude a picture pasted
 * into a prompt (`<entry uuid>:<block index>`) or one a tool returned
 * (`<entry uuid>:<block index>:<index in the result>`). The transcript holds it as base64, so it
 * is decoded here rather than sent with every poll of the conversation. Null when there is no such
 * image. Codex uses a hash of the native attachment and searches only the bound history, and names a
 * picture a tool returned by its call (`codex-tool:<call id>:<nth picture>`); omp names its pictures
 * as pi does.
 */
export async function conversationImage(paneId: string, ref: string, codexHome?: string, opencodeDb?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!CLAUDE_IMAGE_REF.test(ref) && !CODEX_IMAGE_REF.test(ref) && !CODEX_TOOL_IMAGE_REF.test(ref) && !PI_IMAGE_REF.test(ref) && !PI_PROMPT_IMAGE_REF.test(ref) && !OPENCODE_IMAGE_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: ResolvedTranscript;
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes, opencodeDb); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  // OpenCode's store is read per request and keeps nothing for the pane to release
  if (resolved.source === "opencode-transcript") return opencodeImage(resolved.path, resolved.session, ref);
  rememberPaneRead(paneId, resolved.path);
  if (resolved.source === "codex-transcript") {
    if (CODEX_TOOL_IMAGE_REF.test(ref)) return codexToolImage(resolved.path, ref, resolved.codexHome ?? codexHome ?? defaultCodexHome());
    return codexTranscriptImage(codexHistorySegments(resolved.path, resolved.codexHome ?? codexHome), ref, pane.cwd);
  }
  if (resolved.source === "pi-transcript" || resolved.source === "cmd-transcript") return piTranscriptImage(resolved.path, ref);
  // the store is held to the identity it had where the transcript was authorized (ompAuthorizedTranscript):
  // a path above it swapped since cannot move the read elsewhere
  if (resolved.source === "omp-transcript") return ompTranscriptImage(resolved.path, ref, resolved.ompBlobs ?? null);
  return resolved.source === "claude-transcript" ? transcriptImage(resolved.path, ref) : null;
}

/** How much of a transcript the image endpoint reads at a time while it looks for a ref's entry. */
const IMAGE_SEARCH_WINDOW = 1024 * 1024;

/** The short escapes JSON has for some characters inside a string. */
const JSON_SHORT_ESCAPES: Readonly<Record<string, string>> = { '"': '\\"', "\\": "\\\\", "/": "\\/", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * A pattern for `text` however JSON may write it inside a string (each character as itself, as a
 * \u escape in either case, or as its short escape), over bytes read as latin1, and the longest
 * stretch of bytes it can match.
 */
function jsonTextPattern(text: string): { pattern: RegExp; span: number } {
  const literal = (bytes: string) => bytes.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
  let source = "";
  let span = 0;
  for (const char of text) {
    const forms: string[] = [];
    if (char !== '"' && char !== "\\" && char.codePointAt(0)! >= 0x20) forms.push(literal(Buffer.from(char, "utf8").toString("latin1")));
    const short = JSON_SHORT_ESCAPES[char];
    if (short !== undefined) forms.push(literal(short));
    let units = "";
    for (let index = 0; index < char.length; index += 1) units += "\\\\u" + char.charCodeAt(index).toString(16).padStart(4, "0").replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`);
    forms.push(units);
    source += `(?:${forms.join("|")})`;
    span += Math.max(Buffer.byteLength(char, "utf8"), 6 * char.length);
  }
  return { pattern: new RegExp(source), span };
}

/**
 * Where the lines `text` is in (as JSON writes it, jsonTextPattern) lie in [from, to) of the stream,
 * found a window at a time, so a transcript is searched and never held whole. A line off the branch
 * reads blank (readStream).
 */
function linesWith(stream: TranscriptStream, text: string, from: number, to: number): [number, number][] {
  return finish(linesWithSteps(stream, text, from, to));
}

/** linesWith in steps a window apart (Steps). */
function* linesWithSteps(stream: TranscriptStream, text: string, from: number, to: number): Steps<[number, number][]> {
  const { pattern, span } = jsonTextPattern(text);
  const found: [number, number][] = [];
  let start = from;
  let hit = false;
  // the end of the line so far: text a window's edge cuts in two is still found
  let tail = "";
  for (let position = from; position < to; position = Math.min(to, position + IMAGE_SEARCH_WINDOW)) {
    const bytes = readStream(stream, position, Math.min(to, position + IMAGE_SEARCH_WINDOW)).toString("latin1");
    for (let offset = 0; ;) {
      const newline = bytes.indexOf("\n", offset);
      if (!hit) {
        const seen = tail + bytes.slice(offset, newline === -1 ? bytes.length : newline);
        hit = pattern.test(seen);
        tail = span > 1 ? seen.slice(-(span - 1)) : "";
      }
      if (newline === -1) break;
      if (hit) found.push([start, position + newline]);
      start = position + newline + 1;
      hit = false;
      tail = "";
      offset = newline + 1;
    }
    if (position + IMAGE_SEARCH_WINDOW < to) yield;
  }
  if (hit) found.push([start, to]);
  return found;
}

/** The bytes of a string a record's shape keeps: ids and names whole, an output's or a picture's start. */
const SHAPE_STRING_BYTES = 1024;
/** The most of one record's shape the endpoint holds: past it the record is not judged, and nothing it could decide is served. */
const SHAPE_MAX_BYTES = 4 * 1024 * 1024;
/** The longest text claudeImageType takes for a picture: MAX_IMAGE_BYTES decoded, and the padding it leaves out. */
const PICTURE_TEXT_BYTES = Math.floor((MAX_IMAGE_BYTES + 3) * 4 / 3);

interface RecordShape { entry: TranscriptEntry; cut: [number, number][]; mark: string }
/** a record that is no JSON object, which the parser skips too */
const NOT_A_RECORD = "not a record";
/** a record past what the endpoint holds, which it cannot judge */
const UNREAD = "unread";
type ShapeRead = RecordShape | typeof NOT_A_RECORD | typeof UNREAD;

/**
 * One transcript record, parsed as the page parses it but read a window at a time: every string past
 * SHAPE_STRING_BYTES is cut there (its rest checked as JSON.parse would check it) and ends in a mark
 * no record can hold, a nonce made for this read, and its place in `cut` (`wholeString` reads it
 * back). So a record of any size costs a window and its shape, and a picture only its own text.
 */
function recordShape(stream: TranscriptStream, range: [number, number]): ShapeRead {
  return finish(recordShapeSteps(stream, range));
}

/** recordShape in steps a window apart (Steps). */
function* recordShapeSteps(stream: TranscriptStream, [start, end]: [number, number]): Steps<ShapeRead> {
  const nonce = randomUUID();
  const kept: Buffer[] = [];
  let size = 0;
  const cut: [number, number][] = [];
  let inString = false;
  // -1 just after a backslash; n > 0 while a \u escape has n hex digits to come
  let escape = 0;
  let length = 0;
  let cutting = false;
  let stringStart = 0;
  const keep = (bytes: Buffer) => { kept.push(Buffer.from(bytes)); size += bytes.length; };
  for (let position = start; position < end; position += IMAGE_SEARCH_WINDOW) {
    const bytes = readStream(stream, position, Math.min(end, position + IMAGE_SEARCH_WINDOW));
    let from = cutting ? -1 : 0;
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index]!;
      if (!inString) {
        if (byte === 0x22) { inString = true; length = 0; escape = 0; stringStart = position + index + 1; }
        continue;
      }
      if (escape === -1) {
        // the bytes no longer kept are held to JSON's own rules: an escape it has, no raw control byte
        if (cutting && !JSON_ESCAPE_LETTERS.has(byte)) return NOT_A_RECORD;
        escape = byte === 0x75 ? 4 : 0;
      } else if (escape > 0) {
        if (cutting && !isHexDigit(byte)) return NOT_A_RECORD;
        escape -= 1;
      } else if (byte === 0x5c) escape = -1;
      else if (byte === 0x22) {
        inString = false;
        if (cutting) {
          cutting = false;
          cut.push([stringStart, position + index]);
          keep(Buffer.from(`\\u0000${nonce}:${cut.length - 1}`));
          from = index;
        }
        continue;
      } else if (cutting && byte < 0x20) return NOT_A_RECORD;
      if (cutting) continue;
      length += 1;
      // cut only between escapes, so what is kept still reads as JSON
      if (escape === 0 && length >= SHAPE_STRING_BYTES) {
        cutting = true;
        keep(bytes.subarray(from, index + 1));
        from = -1;
      }
    }
    if (from !== -1) keep(bytes.subarray(from));
    if (size > SHAPE_MAX_BYTES) return UNREAD;
    if (position + IMAGE_SEARCH_WINDOW < end) yield;
  }
  let entry: unknown;
  try { entry = JSON.parse(Buffer.concat(kept).toString("utf8")); } catch { return NOT_A_RECORD; }
  return entry !== null && typeof entry === "object" ? { entry: entry as TranscriptEntry, cut, mark: `\u0000${nonce}:` } : NOT_A_RECORD;
}

/** The letters JSON allows after a backslash. */
const JSON_ESCAPE_LETTERS = new Set([...'"\\/bfnrtu'].map((letter) => letter.charCodeAt(0)));
function isHexDigit(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

/**
 * A string of a record's shape whole, as JSON decodes it, decoded a window at a time; null when it
 * decodes to more than `limit` characters.
 */
function wholeString(stream: TranscriptStream, shape: RecordShape, value: string, limit: number): string | null {
  return finish(wholeStringSteps(stream, shape, value, limit));
}

/** wholeString in steps a window apart (Steps). */
function* wholeStringSteps(stream: TranscriptStream, shape: RecordShape, value: string, limit: number): Steps<string | null> {
  let whole = "";
  return (yield* scanStringSteps(stream, shape, value, limit, (piece) => { whole += piece; })) ? whole : null;
}

/**
 * A string of a record's shape as JSON decodes it, handed to `visit` a window's piece at a time and
 * never held whole, in steps a window apart (Steps); false when it decodes to more than `limit`
 * characters.
 */
function* scanStringSteps(stream: TranscriptStream, shape: RecordShape, value: string, limit: number, visit: (piece: string) => void): Steps<boolean> {
  const at = value.lastIndexOf(shape.mark);
  const range = at === -1 ? undefined : shape.cut[Number(value.slice(at + shape.mark.length))];
  if (range === undefined) {
    if (value.length > limit) return false;
    visit(value);
    return true;
  }
  // a BOM at a string's start is its text, as Buffer#toString keeps it for the page
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let length = 0;
  let pending = "";
  for (let position = range[0]; position <= range[1]; position += IMAGE_SEARCH_WINDOW) {
    const last = position + IMAGE_SEARCH_WINDOW >= range[1];
    const text = pending + (last ? decoder.decode(readStream(stream, position, range[1])) : decoder.decode(readStream(stream, position, position + IMAGE_SEARCH_WINDOW), { stream: true }));
    // decode up to the last whole escape: the rest waits for the next window
    let split = text.length;
    if (!last) {
      split = 0;
      for (let index = 0; index < text.length;) {
        if (text[index] !== "\\") { index += 1; split = index; continue; }
        const next = index + (text[index + 1] === "u" ? 6 : 2);
        if (next > text.length) break;
        index = next;
        split = index;
      }
    }
    const piece = JSON.parse(`"${text.slice(0, split)}"`) as string;
    pending = text.slice(split);
    length += piece.length;
    if (length > limit) return false;
    visit(piece);
    if (last) break;
    yield;
  }
  return true;
}

/** A tool call's id as the parser keys it: its text (a number's too), read whole; null past what the endpoint reads. */
function callId(stream: TranscriptStream, shape: RecordShape, id: unknown): string | null {
  return typeof id === "string" ? wholeString(stream, shape, id, PICTURE_TEXT_BYTES) : String(id ?? "");
}

/**
 * Whether a tool result before `before` would be drawn, as the parser decides it: it answers a call
 * an assistant entry the parser draws made, and no result before it answered that call already.
 * False too when a record it would have to judge is past what the endpoint reads: then it serves
 * nothing rather than guess.
 */
function answersDrawnCall(stream: TranscriptStream, id: string, before: number): boolean {
  const ranges = linesWith(stream, id, stream.floor, before);
  // a call id the parser took from a number can be written in any of a number's spellings
  if (id !== "" && String(Number(id)) === id) {
    const seen = new Set(ranges.map(([start]) => start));
    for (const range of linesWith(stream, "tool_use", stream.floor, before)) if (!seen.has(range[0])) ranges.push(range);
    ranges.sort((left, right) => left[0] - right[0]);
  }
  let open = false;
  for (const range of ranges) {
    const shape = recordShape(stream, range);
    if (shape === UNREAD) return false;
    if (shape === NOT_A_RECORD) continue;
    const entry = shape.entry;
    if (entry.isMeta || entry.isCompactSummary || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      const part = block as { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown } | null;
      const call = entry.type === "assistant" && part?.type === "tool_use" && typeof part.name === "string" ? callId(stream, shape, part.id)
        : entry.type === "user" && part?.type === "tool_result" && typeof part.tool_use_id === "string" ? callId(stream, shape, part.tool_use_id) : undefined;
      if (call === undefined) continue;
      if (call === null) return false;
      if (call === id) open = part?.type === "tool_use";
    }
  }
  return open;
}

/**
 * The image an image part's ref names in a Claude transcript file, decoded; null when there is none,
 * or when it is no picture the page would name (claudeImageType: the same check, so they agree). It
 * is read as the page is: after the last /clear, on the branch a rewind left the session on, and a
 * tool's picture only from a result the page draws. It holds a window, a record's shape and the
 * picture's own bytes at a time, never a record or the transcript whole.
 */
export function transcriptImage(path: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = CLAUDE_IMAGE_REF.exec(ref);
  if (match === null) return null;
  const [, uuid, index, nested] = match;
  try {
    const stream = transcriptStream("claude-transcript", path, statSync(path), defaultCodexHome());
    applyHistoryBoundary(path, stream, "claude-transcript");
    for (const range of linesWith(stream, uuid!, stream.floor, stream.length)) {
      const shape = recordShape(stream, range);
      // a record the endpoint cannot judge could be the one the page draws: serve nothing then
      if (shape === UNREAD) return null;
      if (shape === NOT_A_RECORD) continue;
      const entry = shape.entry;
      // only an entry the parser draws: a hidden one can carry the same id
      if (entry.uuid !== uuid || entry.type !== "user" || entry.isMeta || entry.isCompactSummary || !Array.isArray(entry.message?.content)) continue;
      const content: unknown[] = entry.message.content;
      const block = content[Number(index)] as { type?: unknown; content?: unknown; tool_use_id?: unknown } | undefined;
      let image: unknown = block;
      if (nested !== undefined) {
        // a tool's picture sits inside the result it returned, drawn only when that result answers
        // a call the page shows, which no result before it answered
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string" || !Array.isArray(block.content)) return null;
        const call = callId(stream, shape, block.tool_use_id);
        if (call === null) return null;
        const answered = content.slice(0, Number(index)).some((other) => {
          const result = other as { type?: unknown; tool_use_id?: unknown } | null;
          return result?.type === "tool_result" && typeof result.tool_use_id === "string" && callId(stream, shape, result.tool_use_id) === call;
        });
        if (answered || !answersDrawnCall(stream, call, range[0])) return null;
        image = block.content[Number(nested)];
      }
      // the picture's own bytes, read whole only up to the largest picture the chat shows
      const picture = image as { source?: { data?: unknown } } | null | undefined;
      const data = typeof picture?.source?.data === "string" ? wholeString(stream, shape, picture.source.data, PICTURE_TEXT_BYTES) : null;
      if (data === null) return null;
      const mediaType = claudeImageType({ ...picture, source: { ...picture!.source, data } });
      if (mediaType === null) return null;
      return { mediaType, bytes: new Uint8Array(Buffer.from(data, "base64")) };
    }
  } catch { return null; }
  return null;
}

const TOOL_REF = /^[A-Za-z0-9_:.-]{1,128}$/;
/** A whole output is still bounded: a page of it, not a log file. */
const TOOL_OUTPUT_MAX = 2_000_000;

/** The whole output of a tool call whose page output was cut, by its id; null when there is none. */
export async function toolOutput(paneId: string, ref: string, codexHome?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string): Promise<string | null> {
  if (!TOOL_REF.test(ref) && !/^cp[0-9a-f]{16}\.[A-Za-z0-9_:.-]{1,128}(?:@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32})?$/.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: ResolvedTranscript;
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes, opencodeDb, hermesHome, grokHome, museData); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  if (resolved.source === "opencode-transcript") {
    const output = opencodeToolOutput(resolved.path, resolved.session, ref);
    return output !== null && output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  rememberPaneRead(paneId, resolved.path);
  if (resolved.source === "hermes-transcript") return hermesToolOutput(resolved.sessionId, resolved.path, ref, TOOL_OUTPUT_MAX);
  let nativeRef = ref;
  if (resolved.source === "copilot-transcript") {
    let history: string;
    try { history = copilotHistoryIdentity(resolved.path); } catch { return null; }
    const prefix = copilotPrefix(paneId, `${resolved.binding}\0${history}`);
    if (!ref.startsWith(prefix)) return null;
    nativeRef = ref.slice(prefix.length);
    if (!nativeRef.includes("@")) return null;
  }
  const output = transcriptToolOutput(resolved.source, resolved.path, nativeRef, resolved.codexHome ?? codexHome);
  if (resolved.agy && !sameAgyStore(resolved.agy, await resolveAgyStore(pane))) return null;
  if (resolved.source === "copilot-transcript") {
    const current = await copilotTranscriptPath(pane, snapshot.panes, resolved.peerClaims).catch(() => null);
    if (current?.path !== resolved.path || current.binding !== resolved.binding) return null;
    try {
      if (!ref.startsWith(copilotPrefix(paneId, `${resolved.binding}\0${copilotHistoryIdentity(resolved.path)}`))) return null;
    } catch { return null; }
  }
  return output;
}

/** The output a transcript file holds for one tool call id, whole (up to TOOL_OUTPUT_MAX). */
export function transcriptToolOutput(source: StreamSource, path: string, ref: string, codexHome?: string): string | null {
  if (!TOOL_REF.test(ref) && !(source === "copilot-transcript" && /^[A-Za-z0-9_:.-]{1,128}@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/.test(ref))) return null;
  if (source === "codex-transcript") {
    let segments: ReturnType<typeof codexHistorySegments>;
    try { segments = codexHistorySegments(path, codexHome); } catch { return null; }
    for (const segment of segments) {
      let text: string;
      // a rollout may have been archived since resolution: the others still hold theirs
      try { text = readRange(segment.path, 0, segment.end); } catch { continue; }
      const output = outputInText(source, text, ref);
      if (output !== null) return output;
    }
    return null;
  }
  if (source === "grok-transcript") return grokToolOutput(path, ref);
  if (source === "agy-transcript") return agyToolOutput(path, ref);
  if (source === "muse-transcript") {
    const output = museToolOutput(path, ref);
    return output !== null && output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  if (source === "letta-transcript") {
    const output = lettaToolOutput(path, ref);
    return output !== null && output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  if (source === "pi-transcript" || source === "cmd-transcript") return piToolOutput(path, ref);
  if (source === "copilot-transcript") {
    let fd: number;
    try { fd = openCopilotFile(path); } catch { return null; }
    try {
      return ref.includes("@") ? copilotOffsetOutput(fd, ref, TOOL_OUTPUT_MAX) : copilotOutput(fd, ref, TOOL_OUTPUT_MAX);
    } finally { closeSync(fd); }
  }
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  return outputInText(source, text, ref);
}

/**
 * One whole tool output by ref. A pi output lives on the active branch only: reading the
 * file whole would answer a ref from a branch a /tree abandoned, whose output the chat
 * never showed, so the branch is read the way the conversation is.
 */
function piToolOutput(path: string, ref: string): string | null {
  let size: number;
  let branch: ReturnType<typeof piBranchSegments>;
  try { size = statSync(path).size; branch = piBranchSegments(path, size); } catch { return null; }
  if (branch === null) return null;
  // only a record that can be a clear or can hold the ref is parsed: an unrelated record (a picture
  // the agent read, a long tool result) is skipped on a substring check, as the segment reader did
  const needle = JSON.stringify(ref);
  let output: string | null = null;
  for (const line of piBranchRecords(path, size)) {
    if (line.includes("context_clear")) {
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (isContextClear(entry, "pi-transcript")) { output = null; continue; }
    }
    if (output === null && line.includes(needle)) output = outputInText("pi-transcript", line, ref);
  }
  return output;
}

/**
 * A picture in a pi conversation, by the ref the page gave it: one a tool call returned
 * (`pi:<call id>:<nth image>`) or one sent in a prompt (`pi-prompt:<entry id>:<nth image>`).
 * Like the output, it is read on the active branch only, after the last clear: a picture from a
 * branch a /tree abandoned, or from before a clear, is one the chat never shows, so it is not offered.
 * The records are read as the parser reads them (parseOmpTranscript): a tool's picture comes only from
 * the result that answers a call it draws, and a prompt's only from a prompt it draws.
 */
export function piTranscriptImage(path: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const tool = PI_IMAGE_REF.exec(ref);
  const match = tool ?? PI_PROMPT_IMAGE_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const [, id, nth] = match;
  let size: number;
  let branch: ReturnType<typeof piBranchSegments>;
  try { size = statSync(path).size; branch = piBranchSegments(path, size); } catch { return null; }
  if (branch === null) return null;
  // only a record that can be a clear or names the id is parsed, both however JSON writes them: an
  // escaped clear or id is still one to the parser
  const clears = jsonTextPattern("context_clear").pattern;
  const names = jsonTextPattern(id).pattern;
  // the parser's state for this one id: whether a call it draws waits for its result, and the first
  // picture it names after the last clear (undefined: none yet; an answer with no such picture names
  // nothing, and a call made again can still name one)
  let open = false;
  let found: { media_type: string; data: string } | null | undefined;
  for (const line of piBranchRecords(path, size)) {
    const clear = clears.test(line);
    if (!clear && (found !== undefined || !names.test(line))) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    if (isContextClear(entry, "pi-transcript")) { open = false; found = undefined; continue; }
    if (found !== undefined) continue;
    // what the parser draws as something other than a message carries no picture of its
    if (skillPromptMessage(entry) !== null || piNotice(entry) !== null || omoTaskResults(entry, new Map()) !== null || (entry as { type?: unknown }).type === "compaction") continue;
    const message = piMessage(entry);
    if (message === null) continue;
    if (tool !== null) {
      // an assistant record opens its calls before the results beside them; any other only answers
      if (message.role === "assistant" && Array.isArray(message.content) && message.content.some((block: unknown) => { const call = block as { type?: unknown; name?: unknown; id?: unknown }; return call.type === "toolCall" && typeof call.name === "string" && call.id === id; })) open = true;
      // the first result for a waiting call is the one drawn; a later one, or one with no call, is not
      if (open && piResults(message).some((result) => result.id === id)) { open = false; found = piImageBlock(message, id, Number(nth)) ?? undefined; }
    } else if (message.role === "user" && (entry as { id?: unknown }).id === id) {
      found = piPromptImages(entry, message).find((picture) => picture.ref === ref);
    }
  }
  return found ? { mediaType: found.media_type, bytes: new Uint8Array(Buffer.from(found.data, "base64")) } : null;
}

/**
 * A picture in an omp conversation, by the ref the page gave it, as pi names them: one a tool call
 * returned (`pi:<call id>:<nth picture>`) or one sent in a prompt (`pi-prompt:<entry id>:<nth
 * picture>`), its bytes inline or in the session's blob store (ompBlobStore, ompBlobPicture). It is
 * read as the page reads omp, the file in one line after the last clear (one JSON writes with escapes
 * too, as the parser reads it), and as the parser draws it (parseOmpTranscript): a tool's picture only
 * from the first result that answers a call the page draws, a prompt's only from a prompt it draws.
 * Like a Claude picture, it holds a window, a record's shape and the picture at a time, never a record
 * or the transcript whole, and it gives the event loop its turn between windows (finishAsync), so a
 * large transcript never holds the bridge for more than a window's work.
 */
export async function ompTranscriptImage(path: string, ref: string, anchor?: string | null): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  try { return await finishAsync(ompTranscriptImageSteps(path, ref, anchor)); } catch { return null; }
}

/**
 * How many records a reader judges between two turns of the event loop: a record's own windows already
 * yield (Steps), and a run of small records yields every so many.
 */
const RECORDS_PER_STEP = 32;

/**
 * ompTranscriptImage's steps. `anchor` is the identity the blob store had when the transcript was
 * authorized (conversationImage: ompBlobAnchor); a blob is read only from that directory. Without one
 * (a caller that authorized nothing first), it is the store as this read starts.
 */
function* ompTranscriptImageSteps(path: string, ref: string, given?: string | null): Steps<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const tool = PI_IMAGE_REF.exec(ref);
  const match = tool ?? PI_PROMPT_IMAGE_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const [, id, nth] = match;
  const blobs = ompBlobStore(path);
  const anchor = given === undefined ? ompBlobAnchor(blobs)?.identity ?? null : given;
  {
    const stream = transcriptStream("omp-transcript", path, statSync(path), defaultCodexHome());
    yield* applyHistoryBoundarySteps(path, stream, "omp-transcript", true);
    // the records that name the id, and those that can be a clear however JSON writes it
    const ranges = yield* linesWithSteps(stream, id, stream.floor, stream.length);
    const seen = new Set(ranges.map(([start]) => start));
    for (const range of yield* linesWithSteps(stream, "context_clear", stream.floor, stream.length)) if (!seen.has(range[0])) ranges.push(range);
    ranges.sort((left, right) => left[0] - right[0]);
    // the parser's state for this one id, as piTranscriptImage keeps it: whether a call it draws waits
    // for its result, and the picture it names after the last clear (null: none yet)
    let open = false;
    let found: { mediaType: string; bytes: Buffer } | null = null;
    let judged = 0;
    for (const range of ranges) {
      if (++judged % RECORDS_PER_STEP === 0) yield;
      const shape = yield* recordShapeSteps(stream, range);
      // a record the endpoint cannot judge could be the one the page draws: serve nothing then
      if (shape === UNREAD) return null;
      if (shape === NOT_A_RECORD) continue;
      const entry: unknown = shape.entry;
      if (isContextClear(entry, "omp-transcript")) { open = false; found = null; continue; }
      if (found !== null) continue;
      // what the parser draws as something other than a message carries no picture of its
      if (skillPromptMessage(entry) !== null || piNotice(entry) !== null || omoTaskResults(entry, new Map()) !== null || (entry as { type?: unknown }).type === "compaction") continue;
      const message = piMessage(entry);
      if (message === null) continue;
      let content: unknown;
      if (tool !== null) {
        // an assistant record opens its calls before the results beside them; any other only answers
        if (message.role === "assistant" && Array.isArray(message.content) && message.content.some((block: unknown) => { const call = block as { type?: unknown; name?: unknown; id?: unknown }; return call.type === "toolCall" && typeof call.name === "string" && call.id === id; })) open = true;
        if (!open) continue;
        const results = message.role === "toolResult" ? [message] : (Array.isArray(message.content) ? message.content : []).filter((block: unknown) => (block as { type?: unknown } | null)?.type === "toolResult");
        const result = (results as { toolCallId?: unknown; content?: unknown }[]).find((block) => block.toolCallId === id);
        if (result === undefined) continue;
        // the first result for a waiting call is the one drawn; a later one, or one with no call, is not
        open = false;
        content = result.content;
      } else {
        if (message.role !== "user" || (entry as { id?: unknown }).id !== id) continue;
        content = message.content;
      }
      // an answer or a prompt with no such picture names nothing, and a call made again can still name one
      found = yield* ompPictureSteps(stream, shape, content, blobs, anchor, Number(nth));
    }
    return found === null ? null : { mediaType: found.mediaType, bytes: new Uint8Array(found.bytes) };
  }
}

/**
 * The picture at place `nth` among an omp record's content blocks, placed as the parser places them
 * (piPictures): an inline picture that passes the check, and a blob ref in omp's form whatever its blob
 * holds. A blob at that place is read now, and gives nothing when it is no picture now rather than the
 * next one. A picture only counted is checked a window at a time; only the one served is held whole.
 */
function* ompPictureSteps(stream: TranscriptStream, shape: RecordShape, content: unknown, blobs: string | null, anchor: string | null, nth: number): Steps<{ mediaType: string; bytes: Buffer } | null> {
  let place = 0;
  for (const value of Array.isArray(content) ? content : []) {
    const block = value as { type?: unknown; mimeType?: unknown; media_type?: unknown; data?: unknown } | null;
    if (block?.type !== "image" || typeof block.data !== "string") continue;
    const declared = typeof block.mimeType === "string" ? block.mimeType : block.media_type;
    if (blobs && block.data.startsWith("blob:")) {
      if (ompBlobDigest(declared, block.data) === null) continue;
      // a store that was no directory when the transcript was authorized answers nothing
      if (place === nth) return anchor === null ? null : yield* ompBlobPictureSteps(blobs, declared, block.data, anchor);
      place += 1;
      continue;
    }
    const scan = new InlinePictureScan();
    const mediaType = (yield* scanStringSteps(stream, shape, block.data, PICTURE_TEXT_BYTES, (piece) => scan.push(piece))) ? scan.type(declared) : null;
    if (mediaType === null) continue;
    if (place === nth) {
      const data = yield* wholeStringSteps(stream, shape, block.data, PICTURE_TEXT_BYTES);
      return data === null ? null : { mediaType, bytes: Buffer.from(data, "base64") };
    }
    place += 1;
  }
  return null;
}

/**
 * A picture a Codex tool returned, by the ref the page gave it (`codex-tool:<call id>:<nth picture>`).
 * It is read from the history the page reads (codexHistorySegments: the rollouts this one continues,
 * without the bytes a backtrack left behind) and as the parser draws it (parseCodexTranscript): only
 * from the first output answering a call it draws, and only the output's own pictures, never the copy an
 * image generation's event keeps. Like a Claude picture, it holds a window, a record's shape and the
 * picture at a time, never a record or the rollout whole, and it gives the event loop its turn between
 * windows (finishAsync).
 */
export async function codexToolImage(path: string, ref: string, codexHome: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  try { return await finishAsync(codexToolImageSteps(path, ref, codexHome)); } catch { return null; }
}

function* codexToolImageSteps(path: string, ref: string, codexHome: string): Steps<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const match = CODEX_TOOL_IMAGE_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const [, id, nth] = match;
  {
    const stream = transcriptStream("codex-transcript", path, statSync(path), codexHome);
    // whether a call the parser draws waits for its output: a call made again opens it again
    let open = false;
    let judged = 0;
    for (const range of yield* linesWithSteps(stream, id, stream.floor, stream.length)) {
      if (++judged % RECORDS_PER_STEP === 0) yield;
      const shape = yield* recordShapeSteps(stream, range);
      if (shape === UNREAD) return null;
      if (shape === NOT_A_RECORD) continue;
      const entry = shape.entry as { type?: unknown; payload?: unknown };
      const payload = (entry.payload !== null && typeof entry.payload === "object" ? entry.payload : {}) as { type?: unknown; call_id?: unknown; output?: unknown };
      if (entry.type !== "response_item" || payload.call_id !== id) continue;
      if (payload.type === "function_call" || payload.type === "custom_tool_call") { open = true; continue; }
      if ((payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") || !open) continue;
      open = false;
      let place = 0;
      for (const value of Array.isArray(payload.output) ? payload.output : []) {
        const part = value as { type?: unknown; image_url?: unknown } | null;
        if (part?.type !== "input_image" || typeof part.image_url !== "string") continue;
        // a data URL is the picture's text and its type, a few bytes longer than the longest picture;
        // one only counted is checked a window at a time, and only the one served is held whole
        const scan = new DataUrlPictureScan();
        if (!(yield* scanStringSteps(stream, shape, part.image_url, PICTURE_TEXT_BYTES + 64, (piece) => scan.push(piece))) || scan.type() === null) continue;
        if (place === Number(nth)) {
          const url = yield* wholeStringSteps(stream, shape, part.image_url, PICTURE_TEXT_BYTES + 64);
          const picture = url === null ? null : codexOutputPicture({ type: "input_image", image_url: url });
          return picture === null ? null : { mediaType: picture.mediaType, bytes: new Uint8Array(Buffer.from(picture.data, "base64")) };
        }
        place += 1;
      }
    }
  }
  return null;
}

function outputInText(source: RecognizedConversation["source"], text: string, ref: string): string | null {
  text = activeHistoryText(text, source);
  const needle = JSON.stringify(ref);
  // a senpi host tool result names its call inside its header's text, not as a JSON string
  const hostNeedle = `id=${ref}):`;
  // Claude Code's own result for a call, kept until no host result for the call follows it
  let native: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes(needle) && !(source === "claude-transcript" && line.includes(hostNeedle))) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    let output: string | null = null;
    if (source === "claude-transcript") {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      const host = entryHostToolResults(entry, content).filter((result) => result.id === ref).at(-1);
      const result = Array.isArray(content) ? content.find((block) => (block as { type?: unknown; tool_use_id?: unknown } | null)?.type === "tool_result" && (block as { tool_use_id?: unknown }).tool_use_id === ref) : undefined;
      if (host !== undefined) output = claudeResultText((content as unknown[]).slice(host.header + 1, host.end));
      // senpi's denial is no output: the host's result for the call comes in a later entry, and wins
      // over any denial wording this does not know
      else if (result !== undefined && native === null && !isHostHandoff(result as { content?: unknown; is_error?: unknown })) native = claudeResultText((result as { content?: unknown }).content);
    } else if (source === "codex-transcript") {
      const payload = entry.payload as { type?: unknown; call_id?: unknown; output?: unknown } | undefined;
      if ((payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") && payload.call_id === ref) output = codexOutputText(payload.output);
    } else {
      const message = piMessage(entry);
      if (message) output = piResults(message).find((result) => result.id === ref)?.text ?? null;
    }
    if (output !== null) return output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  return native !== null && native.length > TOOL_OUTPUT_MAX ? `${native.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : native;
}

/** Asset reads share the reset boundary even when their ref predates /clear. */
function activeHistoryText(text: string, source: RecognizedConversation["source"]): string {
  if (source === "codex-transcript") return text;
  let start = 0, offset = 0;
  for (const line of text.split("\n")) {
    if (line.includes("context_clear") || line.includes("/clear")) {
      try { if (isContextClear(JSON.parse(line), source)) start = offset + line.length + 1; } catch { /* torn line */ }
    }
    offset += line.length + 1;
  }
  return text.slice(start);
}
