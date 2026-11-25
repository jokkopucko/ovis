/**
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
 */

import { createHash, randomUUID, type Hash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { open as openHandle, readdir, readFile, type FileHandle } from "node:fs/promises";
import { readStatuslineContext } from "./statusline.ts";
import { transcriptReader, type TranscriptFile } from "./transcript-reader.ts";
import nodePath, { basename, dirname, relative, sep, type PlatformPath } from "node:path";
import { isDshProcess, jobDsh, resolveDshTranscript, dshConversation, dshToolOutput, type DshTranscript } from "./dsh.ts";
import { isKiroChatProcess, resolveKiroTranscript, kiroConversation, kiroToolOutput, type KiroTranscript } from "./kiro.ts";
import { authorizedTranscript } from "./transcript-store.ts";

import type { ConversationMetadata, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, herdrSocketPath, paneProcessInfo, paneRead, paneScrollInfo, sessionSnapshot, type ProcessInfo } from "./herdr/client.ts";
import { resolveAgent } from "./pane-context.ts";
import { servedStatus } from "./approvals/codex.ts";
import { codexFreshSession, codexHistorySegments, createCodexTranscriptParser, type HistorySegment, codexOutputText, codexTranscriptPath, defaultCodexHome, forgetAllCodexState, forgetCodexStateFor, paneCodexHomePlaced, paneCodexProcess, parseCodexTranscript, readRange, rolloutThread } from "./codex.ts";
import { awaited, CODEX_IMAGE_REF, CODEX_TOOL_IMAGE_REF, codexOutputPicture, codexTranscriptImage, DataUrlPictureScan, finish, finishAsync, forgetOmpBlobTypes, InlinePictureScan, MAX_IMAGE_BYTES, ompBlobAnchor, ompBlobDigest, ompBlobPictureSteps, type Steps } from "./codex-images.ts";
import { type Held, heldOpenPlatform, openHeldDirectory } from "./held-open.ts";
import { AmbiguousClaudeStore, claudeAttachSession, claudeProcessSession, claudeTranscriptFile, darwinProcess, defaultClaudeConfigDir, forgetClaudeSessionFile, forgetClaudeSessions, hintedClaudeConfigDir, isClaudeProcess, jobClaude, processClaudeConfigDir, windowsShellClaude } from "./claude-store.ts";
import { coreSocket } from "./herdr-core/core-socket.ts";
import { coreAcp, coreSocketPath } from "./herdr-core/runtime.ts";
import { capabilities } from "./runtime/capabilities.ts";
import { forgetGjcPane, forgetGjcState, gjcPidUnderShell, gjcTranscriptFileForPane, isGjcProcess, recentProcessTable, storeRelative } from "./gjc-runtime.ts";
import { isOmoProcess, omoProcessIdentity, omoSessionForPane, processEnviron, processInfo as omoPaneProcessInfo, withOmoDescendants, type ProcessInfo as OmoProcessInfo } from "./omo.ts";
import { processAlive, processStartedAtAsync } from "./process-start.ts";
import { ompBlobStore, ompHeldOpen, ompPaneRoute, ompRouteOwns, ompRouteStore, ompRouteTranscript } from "./omp.ts";
import { forgetOpencodeRead, forgetOpencodeState, OPENCODE_IMAGE_REF, opencodeConversation, opencodeDatabasePath, opencodeFreshSession, opencodeImage, opencodeReadKey, opencodeSessionId, opencodeToolOutput } from "./opencode.ts";
import { PI_NPM_ENTRY, piTranscriptPath, unwrittenSession } from "./pi.ts";
import { cmdModelCatalogPath, cmdTranscriptPath } from "./cmd.ts";
import { defaultDevinDbPath, DevinHistoryUnavailable, devinConversation, forgetDevinState } from "./devin.ts";
import { forgetGrokState, GROK_IMAGE_REF, grokImage, grokProjection, grokToolOutput, parseGrokTranscript, GrokUnavailable } from "./grok.ts";
import { resolveGrokStore } from "./grok-store.ts";
import { AGY_CATALOG_BYTES, AgyUnavailable, agyCatalogOffThread, agyDatabasePath, agyToolOutput, forgetAgyState, parseAgyTranscript, withAgyHistory, type AgyProjection } from "./agy.ts";
import { agyFreshSession, resolveAgyStore, sameAgyStore, type AgyStore } from "./agy-store.ts";
import { FileBusyError } from "./file-pool.ts";
import { museSession, museToolOutput, MuseUnavailable, parseMuseTranscript } from "./muse.ts";
import { MuseLogUnreadable, resolveMuseSession } from "./muse-store.ts";
import { LettaUnavailable, lettaToolOutputOffThread, parseLettaTranscript } from "./letta.ts";
import { programName } from "./agent-identity.ts";
import { lettaLocalSettings, resolveLettaTranscript } from "./letta-store.ts";
import { followKimiUndo, kimiToolOutput, kimiTranscriptPathForPane, parseKimiTranscript, type KimiUndo } from "./kimi.ts";
import { withinRetentionBudget } from "./retention-budget.ts";
import { forgetAllPiIndexes, forgetPiIndex, piAbandonedTurns, piBranchRecords, piBranchSegments } from "./pi-tree.ts";
import { COPILOT_IMAGE_REF, copilotImage, copilotOffsetOutput, copilotOutput, copilotRootRecord, parseCopilotTranscript } from "./copilot.ts";
import { copilotApiTranscript, copilotExplicitResume, copilotHandoffSession, copilotProcessSession, copilotTranscriptFile, copilotUnwrittenSession, openCopilotFile, readCopilotProcessSession } from "./copilot-store.ts";
import { forgetCopilotForeground, readCopilotForeground } from "./copilot-foreground.ts";
import { claudeSetting, type MetadataFold, parseConversationMetadata } from "./conversation-metadata.ts";
import { catalogVersion, piCatalogVersion } from "./pi-models.ts";
import type { ToldMode } from "./approvals/hub.ts";
import { answerVersion, bindFile, boundSteps, checkBoundFile, ConversationNotStarted, ConversationReadPending, ConversationUnavailable, copilotRecoverable, type FileIdentity, openBound, readBound, type ConversationPage, HistoryChanged, type RecognizedConversation, type StreamSource, TRANSCRIPT_WINDOW_BYTES } from "./conversation-shared.ts";
import { forgetHermesTranscriptState, hermesConversationPage, hermesToolOutput, hermesTranscriptForPane } from "./hermes.ts";

import { createOmpTranscriptParser, isContextClear, MAX_TURNS, omoTaskResults, parseOmpTranscript, PI_IMAGE_REF, PI_PROMPT_IMAGE_REF, piImageBlock, piMessage, piNotice, piPromptImages, piResults, type TranscriptParser, withHcNotes } from "./transcript-records.ts";
import { omoAnswerEntry, type OmoAskState, omoAskUpdates } from "./omo-ask.ts";
import { skillPromptMessage } from "./skill-activity.ts";
import { CLAUDE_IMAGE_REF, claudeImageType, claudeResultText, createClaudeTranscriptParser, entryHostToolResults, isHostHandoff, parseClaudeTranscript, type TranscriptEntry } from "./claude-transcript.ts";
import { POLL_TOOL, REPL_TOOL, replDeliveries, replDispatched, replOutput, virtualCallOutput } from "./claude-code-mode.ts";
import { forgetSubagents, lineNotifications, subagentDetails, type SubagentDetail } from "./claude-subagents.ts";
import { launchedAgents } from "./launched-agents.ts";
import { readsStartScreen, startScreenMetadata } from "./start-screen.ts";
import { commandTranscriptRecords, PI_EVIDENCE_TYPES, type CommandTranscriptRecord } from "./outcome.ts";
import { type ClaudeBranch, claudeForks, followClaudeBranch, type PromptChain, turnStarts } from "./transcript-turns.ts";
import { copilotSetAside } from "./copilot.ts";
import { DevinLockMissing, devinLockProof, devinSessionForPane, isDevinProcess, type DevinLockProof } from "./devin-session.ts";
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

const MAX_PAGE_BYTES = 16 * 1024 * 1024;
/**
 * How far back a Copilot page reaches for the start of its turn: Copilot interns every picture of a
 * turn in it as base64 (`session.binary_asset`), so one turn with a few pictures passes a window
 * (#2478). Its pages widen to the turn's start, the newest one too, up to this.
 */
const COPILOT_PAGE_BYTES = 4 * MAX_PAGE_BYTES;

function pagePrompts(page: ConversationPage): number {
  const asked = page.prompts;
  if (typeof asked !== "number" || !Number.isFinite(asked)) return DEFAULT_PAGE_PROMPTS;
  return Math.min(MAX_PAGE_PROMPTS, Math.max(1, Math.floor(asked)));
}

const METADATA_HEAD_BYTES = 64 * 1024;

/** Session ids are uuids; refusing anything else keeps the path traversal-free. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const writtenSessions = new Set<string>();

/** The permission mode the hook of a Claude Ovis started in a pane last told, and in which session (the approval hub's). */
let toldMode: (paneId: string) => ToldMode | null = () => null;
export function readToldModes(read: ((paneId: string) => ToldMode | null) | null): void {
  toldMode = read ?? (() => null);
}

/**
 * `answer` with the permission mode a hook told in `session`, the session the answer's transcript is: a mode told in
 * another one (before a /resume or a /clear, or by an agent no longer running there) leaves the transcript's.
 */
export function withToldMode<T extends Pick<RecognizedConversation, "metadata" | "version">>(answer: T, told: ToldMode | null, session: string): T {
  if (told === null || told.session !== session || told.mode === answer.metadata.permission_mode) return answer;
  return { ...answer, metadata: { ...answer.metadata, permission_mode: told.mode }, version: answerVersion(answer.version, told.mode) };
}

const cache = new Map<string, { source: RecognizedConversation["source"]; signature: string; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null; abandoned?: { count: number; branches: number; summary: string | null } }>();

const PROCESS_VERSION = randomUUID();
const copilotBindings = new Map<string, { identity: string; prefix: string; session: string }>();

function copilotPrefix(paneId: string, identity: string, path: string): string {
  const previous = copilotBindings.get(paneId);
  if (previous?.identity === identity) return previous.prefix;
  const prefix = `cp${createHash("sha256").update(`${PROCESS_VERSION}\0${paneId}\0${identity}\0${randomUUID()}`).digest("hex").slice(0, 16)}.`;
  remember(copilotBindings, paneId, { identity, prefix, session: nodePath.basename(nodePath.dirname(path)) }, PANE_READS_MAX);
  return prefix;
}

function copilotHistoryIdentity(path: string): string {
  try {
    const fd = openCopilotFile(path);
    try {
      const stat = fstatSync(fd);
      return `${stat.dev}:${stat.ino}${transcriptGeneration(path, stat)}`;
    } finally { closeSync(fd); }
  } catch (error) {
    if (error instanceof ConversationReadPending) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }
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

interface TranscriptStream {
  /** the live file's identity: cursors from any other file are refused */
  id: string;
  files: { path: string; start: number; length: number; offset: number }[];
  length: number;
  floor: number;
  promptStarts?: number[];
  fd?: number;
  file?: TranscriptFile;
  hidden?: [number, number][];
  current?: () => Steps<boolean>;
  published?: { scan: object; through: number };
  seen?: { from: number; digest: bigint };
  pictures?: PictureIndex;
  version?: { key: string; mtimeMs: number; ctimeMs: number; began: number; wall: number };
}

// In-place rewrites keep the inode.
interface TranscriptRevision { identity: string; size: number; changed: string; generation: string; hash?: Hash; hashed: number; prefix?: { digest: string; at: number }; window?: { start: number; end: number; digests: BigUint64Array }; forced?: true }
const transcriptRevisions = new Map<string, TranscriptRevision>();
const PREFIX_BYTES = 64 * 1024;
type RevisionStat = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
function transcriptGeneration(path: string, stat: RevisionStat, checkWindow = false, read = true): string {
  const reads = revisionReads;
  const deferred = read && reads.mode === "deferred" ? reads : null;
  let wanted = false as boolean;
  const opened: RevisionOpen = deferred === null ? openRevisionNow : function* () { wanted = true; throw new Error("left to settleTranscriptRevision"); };
  const { previous, next: found } = finish(transcriptRevisionSteps(path, stat, checkWindow, read && reads.mode !== "none", opened));
  let next = found;
  if (deferred !== null && wanted) {
    deferred.unsettled = true;
    throw new Error("transcript revision left to settleTranscriptRevision");
  }
  if (read && reads.mode === "none" && next.forced !== true && previous?.identity === next.identity && next.generation === previous.generation && previous.size > 0 && next.size > (next.prefix?.at ?? previous.size)) {
    if (reads.verifiable && !uncheckedGrowths.has(path)) {
      remember(uncheckedGrowths, path, true, 64);
      throw new RevisionUnchecked();
    }
    next = reads.verifiable ? { ...next, generation: randomUUID(), forced: true } : { ...next, generation: randomUUID(), hash: undefined, hashed: 0, prefix: undefined };
  }
  if (read) uncheckedGrowths.delete(path);
  remember(transcriptRevisions, path, next, 64);
  return next.generation ? `-${next.generation}` : "";
}

let revisionReads: { mode: "inline" } | { mode: "deferred"; unsettled: boolean } | { mode: "none"; verifiable: boolean } = { mode: "inline" };

const uncheckedGrowths = new Map<string, true>();

class RevisionUnchecked extends ConversationReadPending {}

interface RevisionTarget { path: string; checkWindow: boolean; live?: () => boolean }

/**
 * The file `path` names as its caller authorized it, taken in the same turn of the event loop, before
 * anything awaits. The page readers follow a link, and so does this; `link` says the settle refuses it,
 * as its open does wherever an open can (O_NOFOLLOW; not Windows).
 */
function authorizedFile(path: string): { dev: number; ino: number; link: boolean } | null {
  try {
    const own = lstatSync(path);
    const stat = own.isSymbolicLink() ? statSync(path) : own;
    return stat.isFile() ? { dev: stat.dev, ino: stat.ino, link: own.isSymbolicLink() && constants.O_NOFOLLOW !== undefined } : null;
  } catch { return null; }
}

function stillAuthorized(path: string, authorized: ReturnType<typeof authorizedFile>): boolean {
  if (authorized === null) return false;
  try {
    const now = statSync(path);
    return now.dev === authorized.dev && now.ino === authorized.ino;
  } catch { return false; }
}

/**
 * Only `authorized` is read, through one handle: a folder on the way swapped since names another file,
 * which is refused, and bytes whose size or mtime changed while they were read record nothing.
 */
async function settleTranscriptRevision({ path, checkWindow, live }: RevisionTarget, authorized = authorizedFile(path)): Promise<void> {
  const start = transcriptRevisions.get(path);
  if (authorized === null || authorized.link) return;
  let handle: FileHandle;
  try { handle = await openHandle(path, REVISION_FLAGS); } catch { return; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== authorized.dev || stat.ino !== authorized.ino || transcriptRevisions.get(path) !== start) return;
    const file: RevisionFile = {
      stat: () => awaited(handle.stat()),
      *read(into, length, position) { return (yield* awaited(handle.read(into, 0, length, position))).bytesRead; },
      *close() {},
    };
    const { previous, next } = await finishAsync(transcriptRevisionSteps(path, stat, checkWindow, true, function* () { return file; }));
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return;
    if (transcriptRevisions.get(path) === previous && (live?.() ?? true)) remember(transcriptRevisions, path, next, 64);
  } catch {} finally { await handle.close().catch(() => {}); }
}

/**
 * The transcript a readSettled page read reads, opened once as authorized: readStream reads it through this
 * handle. The other files a page holds (a Codex rollout before the live one) are opened bound (openBound).
 */
let pageFile: { path: string; fd: number } | null = null;
// a link is followed, as the page readers do; O_NONBLOCK: a FIFO put there is not waited on
const PAGE_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const REVISION_SETTLES = 3;

/**
 * `read`, a synchronous read of `target.path`, with the digests its revision check needs read through
 * the thread pool first (settleTranscriptRevision), from the file authorized as this is called. A change
 * the read meets after that is settled again, REVISION_SETTLES times at most, and the last read reads
 * nothing for its revision. Null when, after a settle, the reader no longer wants it (`live`). The read
 * answers only while the path names the authorized file before and after it. Any other file there (one
 * renamed over it, even from its own folder, or a folder on the way swapped since) may be another
 * session's, and is never read: that read is pending, for the next poll to authorize afresh. A path that
 * named no file to authorize is transcript_missing.
 */
async function readSettled<T>(target: RevisionTarget, read: () => T): Promise<{ value: T } | null> {
  const authorized = authorizedFile(target.path);
  const refuse = () => authorized === null ? new ConversationUnavailable("transcript_missing") : new ConversationReadPending();
  for (let settles = 1; ; settles++) {
    await settleTranscriptRevision(target, authorized);
    if (!(target.live?.() ?? true)) return null;
    const reads = settles < REVISION_SETTLES && authorized?.link !== true ? { mode: "deferred" as const, unsettled: false } : { mode: "none" as const, verifiable: authorized?.link !== true };
    revisionReads = reads;
    try {
      if (authorized === null || !stillAuthorized(target.path, authorized)) throw refuse();
      // the page's bytes come through one handle, the authorized file's: an open of the path itself could
      // meet a folder swapped in around that open alone, which the checks around the read never see
      let fd: number;
      try { fd = openSync(target.path, PAGE_FLAGS); } catch { throw refuse(); }
      let value: T;
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== authorized.dev || opened.ino !== authorized.ino) throw refuse();
        pageFile = { path: target.path, fd };
        // any other open of it (a branch index, a projection) is held to the same file (openBound)
        value = readBound([[target.path, authorized]], read);
      } finally { pageFile = null; closeSync(fd); }
      if (!stillAuthorized(target.path, authorized)) throw refuse();
      if (reads.mode === "none" || !reads.unsettled) return { value };
    } catch (error) {
      if (reads.mode === "none" || !reads.unsettled) throw error;
    } finally { revisionReads = { mode: "inline" }; }
  }
}

function* transcriptRevisionSteps(path: string, stat: RevisionStat, checkWindow: boolean, read: boolean, opened: RevisionOpen): Steps<{ previous: TranscriptRevision | undefined; next: TranscriptRevision }> {
  const identity = `${stat.dev}:${stat.ino}`;
  const changed = `${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = transcriptRevisions.get(path);
  const same = previous !== undefined && previous.identity === identity;
  let rewritten = same && stat.size < previous.size;
  let hash = same && !rewritten ? previous.hash : undefined;
  let hashed = hash ? previous!.hashed : 0;
  // Same size, new timestamps: a rewrite, or only a touch (Claude Code sets its open session's
  // times about hourly, bytes untouched).
  if (same && stat.size === previous.size && changed !== previous.changed) {
    const now = read && hash ? (yield* hashRange(opened, path, stat, createHash("sha256"), 0, hashed)) : undefined;
    if (!now || now.copy().digest("base64") !== hash!.copy().digest("base64")) rewritten = true;
  }
  // Its first bytes must still be the ones read before (an earlier rewrite while growing would otherwise keep
  // the generation, and a same-size restore later match the extended digest). ponytail: only the first
  // 64 KiB, a growing read stays about as cheap as before; a rewrite past them while growing still
  // passes.
  let prefix = same && !rewritten ? previous.prefix : undefined;
  let head: Hash | undefined;
  if (read && prefix && stat.size > prefix.at) {
    head = yield* hashRange(opened, path, stat, createHash("sha256"), 0, Math.min(PREFIX_BYTES, prefix.at));
    if (!head || head.copy().digest("base64") !== prefix.digest) { rewritten = true; head = undefined; }
  }
  if (read && same && !rewritten && prefix === undefined && previous.size > 0 && stat.size > previous.size) rewritten = true;
  // Muse: a rewrite that also grew keeps the inode and passes the checks above, so the window last
  // read must still hold the bytes it held. ponytail: the last 16 MiB only, where the settled turns
  // come from; digest the whole log if a rewrite further back matters.
  let window = previous?.identity === identity ? previous.window : undefined;
  if (checkWindow && (window === undefined || stat.size !== previous!.size || changed !== previous!.changed)) {
    const start = Math.max(0, Math.floor((stat.size - TRANSCRIPT_WINDOW_BYTES) / WINDOW_CHUNK_BYTES) * WINDOW_CHUNK_BYTES);
    if (window !== undefined && window.end <= start) rewritten = true;
    const check = rewritten ? undefined : window;
    const from = check?.start ?? start;
    const bytes = yield* windowBytes(opened, path, stat, from);
    const digests = bytes && chunkDigests(bytes);
    if (check && (!digests || !sameOverlap(check, from, bytes!, digests))) rewritten = true;
    const kept = digests?.slice((start - from) / WINDOW_CHUNK_BYTES);
    window = kept?.length ? { start, end: stat.size, digests: kept } : undefined;
  }
  if (rewritten || stat.size > TRANSCRIPT_WINDOW_BYTES) { hash = undefined; hashed = 0; }
  if (read && stat.size <= TRANSCRIPT_WINDOW_BYTES && (hash === undefined || hashed < stat.size)) {
    hash = yield* hashRange(opened, path, stat, hash?.copy() ?? createHash("sha256"), hash === undefined ? 0 : hashed, stat.size);
    hashed = hash ? stat.size : 0;
  }
  if (rewritten) { prefix = undefined; head = undefined; }
  if (read && prefix?.at !== stat.size) {
    const checked = head ? Math.min(PREFIX_BYTES, prefix!.at) : 0;
    const to = Math.min(PREFIX_BYTES, stat.size);
    head = checked === to ? head : yield* hashRange(opened, path, stat, head ?? createHash("sha256"), checked, to);
    prefix = head ? { digest: head.digest("base64"), at: stat.size } : undefined;
  }
  const generation = rewritten ? randomUUID() : previous?.identity === identity ? previous.generation : "";
  const forced = !read && same && !rewritten && previous.forced === true;
  return { previous, next: forced ? { identity, size: stat.size, changed, generation, hash, hashed, prefix, window, forced } : { identity, size: stat.size, changed, generation, hash, hashed, prefix, window } };
}

interface RevisionFile {
  stat(): Steps<Stats>;
  read(into: Buffer, length: number, position: number): Steps<number>;
  close(): Steps<void>;
}
type RevisionOpen = (path: string) => Steps<RevisionFile>;
// O_NOFOLLOW: a link put in the transcript's place is refused, as the other transcript readers do;
// O_NONBLOCK: a FIFO put there is not waited on
const REVISION_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
function* openRevisionNow(path: string): Steps<RevisionFile> {
  const fd = openSync(path, REVISION_FLAGS);
  return {
    *stat() { return fstatSync(fd); },
    *read(into, length, position) { return readSync(fd, into, 0, length, position); },
    *close() { closeSync(fd); },
  };
}

function* hashRange(opened: RevisionOpen, path: string, stat: { dev: number; ino: number }, hash: Hash, from: number, to: number): Steps<Hash | undefined> {
  const unchanged = (now: Stats): boolean => now.isFile() && now.dev === stat.dev && now.ino === stat.ino && now.size >= to;
  try {
    const file = yield* opened(path);
    try {
      if (!unchanged(yield* file.stat())) return undefined;
      const chunk = Buffer.allocUnsafe(Math.min(Math.max(to - from, 0), 64 * 1024));
      for (let at = from; at < to;) {
        const read = yield* file.read(chunk, Math.min(chunk.length, to - at), at);
        if (read <= 0) return undefined;
        hash.update(chunk.subarray(0, read));
        at += read;
      }
      return unchanged(yield* file.stat()) ? hash : undefined;
    } finally { yield* file.close(); }
  } catch { return undefined; }
}

function* windowBytes(opened: RevisionOpen, path: string, stat: { dev: number; ino: number; size: number }, from: number): Steps<Buffer | null> {
  const unchanged = (now: Stats): boolean => now.isFile() && now.dev === stat.dev && now.ino === stat.ino && now.size >= stat.size;
  try {
    const file = yield* opened(path);
    try {
      if (!unchanged(yield* file.stat())) return null;
      const bytes = Buffer.allocUnsafe(stat.size - from);
      for (let got = 0; got < bytes.length;) {
        const read = yield* file.read(bytes.subarray(got), bytes.length - got, from + got);
        if (read <= 0) return null;
        got += read;
      }
      return unchanged(yield* file.stat()) ? bytes : null;
    } finally { yield* file.close(); }
  } catch { return null; }
}

function transcriptStream(source: StreamSource, path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, codexHome: string, agy?: AgyProjection, fd?: number, leased = false): TranscriptStream {
  const grok = source === "grok-transcript" ? grokProjection(path, stat) : null;
  const branch = (source === "pi-transcript" || source === "cmd-transcript") ? piBranchSegments(path, stat.size) : null;
  if ((source === "pi-transcript" || source === "cmd-transcript") && branch === null) throw new ConversationUnavailable("branch_unreadable");
  const segments: { path: string; start: number; end: number }[] = source === "codex-transcript"
    ? codexHistorySegments(path, codexHome).map((segment) => {
      // each earlier rollout is read as the file it was when its chain was resolved (readStream)
      if (segment.identity) bindFile(segment.path, segment.identity);
      return { path: segment.path, start: 0, end: segment.end };
    })
    : grok !== null ? grok.segments.map((segment) => ({ path, ...segment }))
    : agy ? agy.segments.map((segment) => ({ path, ...segment }))
    : branch !== null ? branch.map((segment) => ({ path, start: segment.start, end: segment.end }))
    : [{ path, start: 0, end: stat.size }];
  const files: TranscriptStream["files"] = [];
  let stream = 0;
  for (const segment of segments) {
    const end = segment.path === path ? Math.min(segment.end, stat.size) : segment.end;
    const length = end - segment.start;
    if (length <= 0) continue;
    files.push({ path: segment.path, start: stream, length, offset: segment.start });
    stream += length;
  }
  // A pi branch is laid out from one file, so its layout stands in for that chain: /tree
  // moves the conversation to other bytes while the file, its inode and its size all stay
  // put.
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
  const version = source === "claude-transcript"
    ? { key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, began: performance.now(), wall: Date.now() } : undefined;
  return { id: `${stat.dev.toString(36)}-${stat.ino.toString(36)}${chain}${transcriptGeneration(path, stat, source === "muse-transcript", !leased)}`, files, length: stream, floor: 0, promptStarts: grok?.promptStarts ?? agy?.promptStarts, fd, version };
}

function readStreamInto(stream: TranscriptStream, from: number, to: number, into: Buffer): Buffer {
  let length = 0;
  for (const file of stream.files) {
    const low = Math.max(from, file.start);
    const high = Math.min(to, file.start + file.length);
    if (low >= high) continue;
    const held = stream.fd ?? (pageFile?.path === file.path ? pageFile.fd : undefined);
    const fd = held ?? openBound(file.path);
    try { length += readSync(fd, into, length, high - low, file.offset + (low - file.start)); }
    finally { if (held === undefined) closeSync(fd); }
  }
  const bytes = into.subarray(0, length);
  for (const [start, end] of stream.hidden ?? []) {
    const low = Math.max(start, from) - from;
    const high = Math.min(end, to, from + bytes.length) - from;
    for (let index = low; index < high; index += 1) if (bytes[index] !== 0x0a) bytes[index] = 0x20;
  }
  return bytes;
}

function readStream(stream: TranscriptStream, from: number, to: number): Buffer {
  const chunks: Buffer[] = [];
  for (const file of stream.files) {
    const low = Math.max(from, file.start);
    const high = Math.min(to, file.start + file.length);
    if (low >= high) continue;
    const held = stream.fd ?? (pageFile?.path === file.path ? pageFile.fd : undefined);
    const fd = held ?? openBound(file.path);
    try {
      const buffer = Buffer.alloc(high - low);
      chunks.push(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, file.offset + (low - file.start))));
    } finally {
      if (held === undefined) closeSync(fd);
    }
  }
  return hideOffBranch(stream, chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks), from, to);
}

/**
 * What one window holds comes in the lease's own buffer, not a new one: it holds only
 * until the next read of the stream, and every reader here takes it in (decodes, copies or digests
 * it) before it reads on.
 */
function* streamBytes(stream: TranscriptStream, from: number, to: number): Steps<Buffer> {
  const file = stream.file;
  if (file === undefined) return readStream(stream, from, to);
  const within = stream.files.filter((segment) => Math.max(from, segment.start) < Math.min(to, segment.start + segment.length));
  if (within.length === 1 && to - from <= LEASE_WINDOW_BYTES) {
    const [segment] = within;
    const low = Math.max(from, segment!.start);
    const bytes = yield* awaited(file.window(segment!.offset + (low - segment!.start), Math.min(to, segment!.start + segment!.length) - low));
    return hideOffBranch(stream, bytes, from, to);
  }
  return yield* awaited((async () => {
    const chunks: Buffer[] = [];
    for (const segment of stream.files) {
      const low = Math.max(from, segment.start);
      const high = Math.min(to, segment.start + segment.length);
      if (low >= high) continue;
      // Each is read straight into its place, not into the lease's window to be copied out (a range of 16 MiB
      // was copied whole)
      const buffer = Buffer.allocUnsafe(high - low);
      let got = 0;
      while (got < buffer.length) {
        const length = Math.min(LEASE_WINDOW_BYTES, buffer.length - got);
        const read = await file.read(segment.offset + (low - segment.start) + got, length, buffer.subarray(got, got + length));
        got += read.length;
        if (read.length < length) break;
      }
      chunks.push(buffer.subarray(0, got));
    }
    return hideOffBranch(stream, chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks), from, to);
  })());
}
const LEASE_WINDOW_BYTES = 1024 * 1024;

function hideOffBranch(stream: TranscriptStream, bytes: Buffer, from: number, to: number): Buffer {
  for (const [start, end] of stream.hidden ?? []) {
    const low = Math.max(start, from) - from;
    const high = Math.min(end, to, from + bytes.length) - from;
    for (let index = low; index < high; index += 1) if (bytes[index] !== 0x0a) bytes[index] = 0x20;
  }
  return bytes;
}

const SETTING_TYPES = ['"model_change"', '"thinking_level_change"'];
const COPILOT_SETTING_TYPES = ['"session.model_change"', '"session.resume"'];
const KIMI_SETTING_TYPES = ['"llm.request"'];
type SettingType = "model_change" | "thinking_level_change" | "copilot_model" | "copilot_effort" | "kimi_request";
/**
 * Claude names its model and effort on every answer, and a /rewind can leave any of them off the
 * branch, so each field keeps every record that set it since the last clear (where it lies, as
 * `branch.answers` does) and a small line that sets the same value again, shared while it repeats.
 */
type ClaudeSettings = Record<"model" | "effort", { line: string; start: number; end: number }[]>;
interface OmoAskIndex { open: Map<string, OmoAskState>; events: { at: number; kind: "open" | "cancelled" | "close"; id: string }[] }
const clearScans = new Map<string, { id: string; source: RecognizedConversation["source"]; scanned: number; floor: number; tail: string; settings: Partial<Record<SettingType, { offset: number; end: number; line: string }>>; branch?: ClaudeBranch; claude?: ClaudeSettings; pictures?: PictureIndex; undo?: KimiUndo; omoAsks?: OmoAskIndex }>();

interface PictureIndex { at: Map<string, IndexedPicture>; loose: UuidMarks; blind: number | null; unread: [number, number][]; bytes: PictureBytes; vouched: ({ key: string } & PictureRead) | null }
interface PictureRead { began: number; wall: number }
interface PictureBytes { from: number; hashed: number; digest: bigint; pending: Uint8Array; through: number }
const PICTURE_DIGEST_BYTES = 64 * 1024;
interface IndexedPicture { start: number; end: number }

interface UuidMarks { table: Uint32Array; count: number; log: Uint32Array; logged: number; read: number; full: boolean }
const MARKS_FOLD_AFTER = 64;
/**
 * The most marks kept: a log of 512 KiB, or a table of 1 MiB at most half full. 128 Ki records the
 * branch does not follow since a /clear is about 25 MB of sidechain records at the least (each is
 * some 200 bytes); past them a picture's record is searched for, as main searches for every one.
 */
const MARKS_LIMIT = 128 * 1024;
const uuidMark = (uuid: string): number => Bun.hash.xxHash32(uuid) || 1;
function marked(marks: UuidMarks, mark: number): boolean {
  const last = marks.table.length - 1;
  for (let slot = mark & last; marks.table.length > 0 && marks.table[slot] !== 0; slot = (slot + 1) & last) if (marks.table[slot] === mark) return true;
  if (marks.logged === 0) return false;
  const seen = marks.log.subarray(0, marks.logged).includes(mark);
  marks.read += marks.logged;
  if (marks.read >= MARKS_FOLD_AFTER * marks.logged) {
    for (const logged of marks.log.subarray(0, marks.logged)) putMark(marks, logged);
    marks.logged = 0;
    marks.read = 0;
  }
  return seen;
}
function markUuid(marks: UuidMarks, mark: number): void {
  if (marks.full) return;
  if (marks.logged + marks.count >= MARKS_LIMIT) {
    Object.assign(marks, { table: new Uint32Array(0), count: 0, log: new Uint32Array(0), logged: 0, read: 0, full: true });
    return;
  }
  if (marks.logged === marks.log.length) {
    const log = new Uint32Array(Math.min(MARKS_LIMIT, Math.max(1024, marks.log.length * 2)));
    log.set(marks.log);
    marks.log = log;
  }
  marks.log[marks.logged++] = mark;
}
function putMark(marks: UuidMarks, mark: number): void {
  if ((marks.count + 1) * 2 > marks.table.length) {
    const old = marks.table;
    marks.table = new Uint32Array(Math.max(1024, old.length * 2));
    marks.count = 0;
    for (const kept of old) if (kept !== 0) putMark(marks, kept);
  }
  const last = marks.table.length - 1;
  let slot = mark & last;
  for (; marks.table[slot] !== 0; slot = (slot + 1) & last) if (marks.table[slot] === mark) return;
  marks.table[slot] = mark;
  marks.count += 1;
}
const noPictures = (from: number, stream: TranscriptStream): PictureIndex => ({
  at: new Map(), loose: { table: new Uint32Array(0), count: 0, log: new Uint32Array(0), logged: 0, read: 0, full: false }, blind: null, unread: [],
  bytes: { from, hashed: from, digest: 0n, pending: new Uint8Array(0), through: from },
  vouched: stream.version ? { key: stream.version.key, began: performance.now(), wall: Date.now() } : null,
});
const pieceEnd = (at: number): number => (Math.floor(at / PICTURE_DIGEST_BYTES) + 1) * PICTURE_DIGEST_BYTES;
function digestPictureBytes(bytes: PictureBytes, data: Uint8Array, at: number): void {
  const skip = bytes.through - at;
  if (skip >= data.length) return;
  // a gap would leave bytes undigested: what follows it is never vouched for
  if (skip < 0) { bytes.through = Number.POSITIVE_INFINITY; return; }
  let rest = data.subarray(skip);
  let pending = bytes.pending;
  for (let need = pieceEnd(bytes.hashed) - bytes.hashed - pending.length; rest.length >= need; need = PICTURE_DIGEST_BYTES) {
    bytes.digest = Bun.hash.xxHash3(pending.length > 0 ? Buffer.concat([pending, rest.subarray(0, need)]) : rest.subarray(0, need), bytes.digest);
    bytes.hashed = pieceEnd(bytes.hashed);
    pending = new Uint8Array(0);
    rest = rest.subarray(need);
  }
  bytes.pending = Buffer.concat([pending, rest]);
  bytes.through = bytes.hashed + bytes.pending.length;
}

function mayBeUnread(line: Buffer): boolean {
  if (line.length > PICTURE_TEXT_BYTES) return true;
  const longest = SHAPE_STRING_BYTES + 64;
  if (line.length * (longest / SHAPE_STRING_BYTES) <= SHAPE_MAX_BYTES) return false;
  let shape = line.length;
  let slash = line.indexOf(0x5c);
  for (let open = line.indexOf(0x22); open !== -1; open = line.indexOf(0x22, open)) {
    let at = open + 1;
    for (;;) {
      const quote = line.indexOf(0x22, at);
      if (quote === -1) return shape > SHAPE_MAX_BYTES;
      if (slash !== -1 && slash < at) slash = line.indexOf(0x5c, at);
      if (slash === -1 || quote < slash) { at = quote; break; }
      at = slash + (line[slash + 1] === 0x75 ? 6 : 2);
    }
    const length = at - open - 1;
    if (length >= SHAPE_STRING_BYTES) shape += longest - length;
    open = at + 1;
  }
  return shape > SHAPE_MAX_BYTES;
}

function holdsPicture(block: unknown): boolean {
  const part = block as { type?: unknown; content?: unknown } | null;
  return part?.type === "image" || (part?.type === "tool_result" && Array.isArray(part.content) && part.content.some((inner) => (inner as { type?: unknown } | null)?.type === "image"));
}

function notePicture(index: PictureIndex, ends: Map<string, number>, known: number, parsed: unknown, line: Buffer, start: number, newline: number): void {
  if (index.loose.full) return;
  const entry = parsed as TranscriptEntry | null | undefined;
  if (entry === null || typeof entry !== "object" || typeof entry.uuid !== "string") return;
  const followed = ends.get(entry.uuid) === newline + 1;
  const picture = index.blind === null && entry.type === "user" && !entry.isMeta && !entry.isCompactSummary
    && Array.isArray(entry.message?.content) && entry.message.content.some(holdsPicture);
  if (followed && !picture) return;
  const mark = uuidMark(entry.uuid);
  const before = picture && ((followed ? ends.size === known : ends.has(entry.uuid)) || marked(index.loose, mark));
  if (!followed) markUuid(index.loose, mark);
  if (!picture || before) return;
  index.at.set(entry.uuid, { start, end: newline });
}

function keepClaudeSetting(settings: ClaudeSettings, entry: unknown, start: number, end: number): void {
  const set = claudeSetting(entry);
  const keep = (field: keyof ClaudeSettings, line: string): void => {
    const last = settings[field].at(-1);
    settings[field].push({ line: last?.line === line ? last.line : line, start, end });
  };
  if (set.model !== undefined) keep("model", JSON.stringify({ type: "assistant", message: { model: set.model } }));
  if (set.effort !== undefined) keep("effort", JSON.stringify({ type: "assistant", effort: set.effort }));
}

function mergedRanges(ranges: readonly [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [low, high] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && low <= last[1]) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function countBefore<T>(items: readonly T[], value: (item: T) => number, bound: number): number {
  let low = 0, high = items.length;
  while (low < high) { const middle = (low + high) >> 1; if (value(items[middle]!) < bound) low = middle + 1; else high = middle; }
  return low;
}
const CLAUDE_CARRY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;
const OMO_CARRY_BYTES = 4 * 1024 * 1024;
function applyHistoryBoundary(path: string, stream: TranscriptStream, source: RecognizedConversation["source"]): void {
  finish(applyHistoryBoundarySteps(path, stream, source, false));
}

function* applyHistoryBoundarySteps(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], apart: boolean, fresh = false): Steps<void> {
  if (source === "codex-transcript" || source === "grok-transcript" || source === "agy-transcript" || source === "muse-transcript" || source === "letta-transcript") return;
  const previous = clearScans.get(path);
  const previousScanned = previous?.scanned;
  let scan = fresh ? undefined : previous;
  if (!scan || scan.id !== stream.id || scan.source !== source || scan.scanned > stream.length || (yield* bytesBeforeSteps(stream, scan.scanned)) !== scan.tail) {
    scan = { id: stream.id, source, scanned: 0, floor: 0, tail: "", settings: {}, ...(source === "claude-transcript" ? { branch: { last: null, ends: new Map(), answers: [], forks: [] }, claude: { model: [], effort: [] }, pictures: noPictures(0, stream) } : {}), ...(source === "kimi-transcript" ? { undo: { anchors: [], undone: [] } } : {}), ...(source === "omo-transcript" ? { omoAsks: { open: new Map<string, OmoAskState>(), events: [] } } : {}) };
  } else if (apart) scan = structuredClone(scan);
  const branch = scan.branch;
  let position = scan.scanned;
  let carry = Buffer.alloc(0);
  let skipping = false;
  let judged = 0;
  if (stream.seen) stream.seen = { from: position, digest: 0n };
  const isClear = (line: Buffer): boolean => {
    if (!line.includes(source === "claude-transcript" ? "/clear" : "context_clear")) return false;
    try { return isContextClear(JSON.parse(line.toString("utf8")), source); } catch { return false; }
  };
  while (position < stream.length) {
    const end = Math.min(stream.length, position + TRANSCRIPT_WINDOW_BYTES);
    const read = yield* streamBytes(stream, position, end);
    if (stream.seen) stream.seen.digest = Bun.hash.xxHash3(read, stream.seen.digest);
    const bytes = Buffer.concat([carry, read]);
    const base = position - carry.length;
    let offset = 0;
    for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
      const line = bytes.subarray(offset, newline);
      if (!skipping && isClear(line)) {
        scan.floor = base + offset;
        if (scan.claude) scan.claude = { model: [], effort: [] };
        // what lies before the /clear is never judged
        if (scan.pictures) scan.pictures = noPictures(base + offset, stream);
        if (scan.omoAsks) scan.omoAsks = { open: new Map<string, OmoAskState>(), events: [] };
      }
      else if (!skipping && source !== "claude-transcript" && (source === "copilot-transcript" ? COPILOT_SETTING_TYPES : source === "kimi-transcript" ? KIMI_SETTING_TYPES : SETTING_TYPES).some((type) => line.includes(type))) {
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
          } else if (source === "kimi-transcript") {
            // Kimi names the model and effort on each request; a compaction's own request is not the chat's
            if (type === "llm.request" && (entry as { kind?: unknown }).kind !== "compaction") scan.settings.kimi_request = { offset: base + offset, end: base + newline, line: line.toString("utf8") };
          } else if (type === "model_change" || type === "thinking_level_change") {
            scan.settings[type] = { offset: base + offset, end: base + newline, line: line.toString("utf8") };
          }
        } catch {}
      }
      if (branch) {
        if (skipping) branch.last = null;
        else {
          const known = branch.ends.size;
          const entry = followClaudeBranch(branch, line, base + offset, base + newline + 1, scan.floor);
          if (entry !== undefined && scan.claude) keepClaudeSetting(scan.claude, entry, base + offset, base + newline);
          if (entry !== undefined && scan.pictures) notePicture(scan.pictures, branch.ends, known, entry, line, base + offset, base + newline);
        }
      }
      if (!skipping && scan.undo) followKimiUndo(scan.undo, line, base + offset, base + newline + 1);
      if (!skipping && scan.omoAsks) {
        const mayOpen = line.includes("ask_user_question") || line.includes("request_user_input") || line.includes("ask-user:");
        const mayClose = scan.omoAsks.open.size > 0 && (line.includes("toolResult") || line.includes("[Answer to question "));
        if (mayOpen || mayClose) {
          try {
            const entry: unknown = JSON.parse(line.toString("utf8"));
            const { open, close } = omoAskUpdates(entry);
            for (const item of open) {
              scan.omoAsks.open.set(item.id, item.state);
              scan.omoAsks.events.push({ at: base + offset, kind: item.state, id: item.id });
            }
            for (const id of close) {
              if (scan.omoAsks.open.delete(id)) scan.omoAsks.events.push({ at: base + offset, kind: "close", id });
            }
            if (scan.omoAsks.open.size > 0) {
              const answered = omoAnswerEntry(entry, scan.omoAsks.open);
              if (answered !== null && scan.omoAsks.open.delete(answered.id)) {
                scan.omoAsks.events.push({ at: base + offset, kind: "close", id: answered.id });
              }
            }
          } catch {}
        }
      }
      if (!skipping && scan.pictures && mayBeUnread(line)) scan.pictures.unread.push([base + offset, base + newline]);
      skipping = false;
      offset = newline + 1;
      scan.scanned = base + offset;
      if (++judged % RECORDS_PER_STEP === 0) yield;
    }
    if (scan.pictures) digestPictureBytes(scan.pictures.bytes, bytes, base);
    carry = bytes.subarray(offset);
    if (carry.length > (branch ? CLAUDE_CARRY_BYTES : scan.omoAsks ? OMO_CARRY_BYTES : METADATA_HEAD_BYTES)) {
      if (scan.pictures && scan.pictures.blind === null) scan.pictures.blind = base + offset;
      // a user's message (Kimi names a record's type and a message's role first) may be a prompt: an
      // /undo counting back over it would take back another
      if (scan.undo && carry.subarray(0, 512).includes('"context.append_message"') && carry.subarray(0, 512).includes('"role":"user"')) scan.undo.anchors = [];
      if (scan.omoAsks && scan.omoAsks.open.size > 0) {
        const prefix = carry.subarray(0, 1024).toString("utf8");
        const framed = /\[Answer to question ([^\]\r\n"\\]+)\\n/.exec(prefix)?.[1];
        if (framed !== undefined && !prefix.includes('"inputSource":"interactive"') && !prefix.includes('"inputSource":"person"') && scan.omoAsks.open.delete(framed)) {
          scan.omoAsks.events.push({ at: base + offset, kind: "close", id: framed });
        }
      }
      carry = Buffer.alloc(0);
      skipping = true;
    }
    position = end;
    if (position < stream.length) yield;
  }
  scan.tail = yield* bytesBeforeSteps(stream, scan.scanned);
  stream.pictures = scan.pictures;
  const kept = () => clearScans.get(path) === previous && previous?.scanned === previousScanned;
  if (!apart || (kept() && (stream.current === undefined || ((yield* stream.current()) && kept())))) {
    remember(clearScans, path, scan, 32);
    if (apart) stream.published = { scan, through: scan.scanned };
  }
  stream.floor = !skipping && carry.length > 0 && isClear(carry) ? stream.length - carry.length : scan.floor;
  if (stream.floor > 0) stream.id += `-clear-${stream.floor.toString(36)}`;
  let undone = scan.undo?.undone ?? [];
  if (scan.undo && !skipping && carry.length > 0) {
    const final = { anchors: [...scan.undo.anchors], undone: [...undone] };
    followKimiUndo(final, carry, stream.length - carry.length, stream.length);
    undone = final.undone;
  }
  const forks = branch ? claudeForks(branch) : undone;
  const hidden = forks.filter(([, end]) => end > stream.floor);
  if (hidden.length > 0) {
    stream.hidden = hidden;
    stream.id += `-fork-${hidden.length}-${hidden.at(-1)![1].toString(36)}`;
  }
}

function pageBefore(stream: TranscriptStream, source: StreamSource, to: number, { floor = stream.floor, widen, prompts }: { floor?: number; widen: boolean; prompts: number }): { start: number; bytes: Buffer } {
  let from = Math.max(floor, to - TRANSCRIPT_WINDOW_BYTES);
  const bytes = readStream(stream, from, to);
  let searched = bytes;
  for (;;) {
    const starts = stream.promptStarts ? stream.promptStarts.filter((at) => at >= from && at < from + searched.length).map((at) => at - from) : turnStarts(searched, source, undefined, turnBlobs(stream, source));
    const keep = starts.length > prompts ? starts[starts.length - prompts] : from === floor ? 0 : starts[0];
    if (keep !== undefined) return searched === bytes ? { start: from + keep, bytes: bytes.subarray(keep) } : { start: from + keep, bytes: readStream(stream, from + keep, to) };
    if (!widen || to - from >= (source === "copilot-transcript" ? COPILOT_PAGE_BYTES : MAX_PAGE_BYTES)) {
      const firstLine = bytes.indexOf(0x0a) + 1;
      return { start: to - bytes.length + firstLine, bytes: bytes.subarray(firstLine) };
    }
    const next = Math.max(floor, from - TRANSCRIPT_WINDOW_BYTES);
    const pieces = [readStream(stream, next, from)];
    for (let at = from; at < to;) {
      const piece = readStream(stream, at, Math.min(to, at + IMAGE_SEARCH_WINDOW));
      if (piece.length === 0) break;
      const lineEnd = piece.indexOf(0x0a);
      pieces.push(lineEnd === -1 ? piece : piece.subarray(0, lineEnd + 1));
      if (lineEnd !== -1) break;
      at += piece.length;
    }
    searched = Buffer.concat(pieces);
    from = next;
  }
}

interface LiveScan {
  id: string;
  source: StreamSource;
  scanned: number;
  starts: number[];
  tail: string;
  chain: PromptChain;
}
const liveScans = new Map<string, LiveScan>();

interface SettledTurns {
  source: RecognizedConversation["source"];
  id: string;
  start: number;
  end: number;
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  tail: string;
  taskTitles: Map<string, string>;
  omoAsks: Map<string, OmoAskState>;
  noticed: Set<string>;
  inherited: Map<string, string>;
  observedEnd: number;
  fold: MetadataFold;
  piAgentDir?: string | null;
  /** the version of the catalogs the windows were resolved in (pi's agent dir, Command Code's catalog) */
  catalogs?: string;
}
const settledTurns = new Map<string, SettledTurns>();

function bytesBefore(stream: TranscriptStream, offset: number): string {
  return readStream(stream, Math.max(0, offset - 64), offset).toString("latin1");
}

function* bytesBeforeSteps(stream: TranscriptStream, offset: number): Steps<string> {
  return (yield* streamBytes(stream, Math.max(0, offset - 64), offset)).toString("latin1");
}

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/**
 * Every cache below is keyed by file, not by pane, and a bridge runs for weeks: without
 * this, everything a pane ever read stays for the life of the process.
 */
interface DevinPaneRead { sessionId: string; cwd: string; dbPath?: string }
interface PaneReads { paths: Set<string>; sessions: Set<string>; devin: Map<string, DevinPaneRead> }
const paneReads = new Map<string, PaneReads>();
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

let bindingCount = 0;
const paneBindings = new Map<string, { key: string; generation: number }>();
const resolvedGenerations = new WeakMap<object, number>();
function noteBinding<T extends NativeTranscript>(paneId: string, resolved: T): T {
  const key = `${resolved.source}\0${resolved.path}`;
  const previous = paneBindings.get(paneId);
  const generation = previous?.key === key ? previous.generation : ++bindingCount;
  remember(paneBindings, paneId, { key, generation }, PANE_READS_MAX);
  resolvedGenerations.set(resolved, generation);
  return resolved;
}
const rebound = (paneId: string, resolved: NativeTranscript): boolean => paneBindings.get(paneId)?.generation !== resolvedGenerations.get(resolved);

function rememberPage<T extends { source: RecognizedConversation["source"] }>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  if ((value.source === "pi-transcript" || value.source === "cmd-transcript") && !withinRetentionBudget(value, PI_PAGE_CACHE_BYTES)) return;
  remember(map, key, value, limit);
  const piKeys = [...map].filter(([, item]) => item.source === "pi-transcript" || item.source === "cmd-transcript").map(([key]) => key);
  while (piKeys.length > 4) map.delete(piKeys.shift()!);
}

function newestPage(path: string, stream: TranscriptStream, source: StreamSource, prompts: number): { start: number; starts: number[] } | null {
  const from = Math.max(stream.floor, stream.length - TRANSCRIPT_WINDOW_BYTES);
  if (stream.promptStarts) {
    const starts = stream.promptStarts.filter((at) => at >= from);
    const start = starts.length > prompts ? starts[starts.length - prompts] : from === stream.floor ? stream.floor : starts[0];
    return start === undefined ? null : { start, starts };
  }
  let scan = liveScans.get(path);
  if (!scan || scan.id !== stream.id || scan.source !== source || scan.scanned > stream.length || scan.scanned < from
    || bytesBefore(stream, scan.scanned) !== scan.tail) {
    scan = { id: stream.id, source, scanned: from, starts: [], tail: bytesBefore(stream, from), chain: { parent: null, answered: true } };
  }
  let pending: number[] = [];
  if (scan.scanned < stream.length) {
    const bytes = readStream(stream, scan.scanned, stream.length);
    const complete = bytes.lastIndexOf(0x0a) + 1;
    for (const offset of turnStarts(bytes.subarray(0, complete), source, scan.chain, turnBlobs(stream, source))) scan.starts.push(scan.scanned + offset);
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

/**
 * Like liveScans it trusts Copilot to append: an earlier line rewritten in place, with
 * the bytes before the read point kept and the file grown, is not noticed.
 */
interface CopilotTurnScan { id: string; start: number; scanned: number; tail: string; lines: { at: number; line: string }[]; bytes: number }
const copilotTurnScans = new Map<string, CopilotTurnScan>();
const COPILOT_TURN_SCAN_BYTES = COPILOT_PAGE_BYTES + TRANSCRIPT_WINDOW_BYTES;

function forgetCopilotTurns(path: string): void {
  for (const key of copilotTurnScans.keys()) if (key.startsWith(`${path}\0`)) copilotTurnScans.delete(key);
}

function copilotNewestTurn(path: string, stream: TranscriptStream, prompts: number): { start: number; lines: CopilotTurnScan["lines"]; partial: string } {
  const key = `${path}\0${prompts}`;
  let scan = copilotTurnScans.get(key);
  let bytes: Buffer | null = null;
  if (scan && scan.id === stream.id && scan.scanned <= stream.length && stream.length - scan.start <= COPILOT_PAGE_BYTES + TRANSCRIPT_WINDOW_BYTES
    && bytesBefore(stream, scan.scanned) === scan.tail) {
    bytes = readStream(stream, scan.scanned, stream.length);
    if (turnStarts(bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1), "copilot-transcript", undefined, null).length > 0) bytes = null;
  }
  if (scan === undefined || bytes === null) {
    const whole = pageBefore(stream, "copilot-transcript", stream.length, { widen: true, prompts });
    scan = { id: stream.id, start: whole.start, scanned: whole.start, tail: "", lines: [], bytes: 0 };
    bytes = whole.bytes;
  }
  let at = 0;
  for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, at)) {
    const line = copilotSetAside(bytes.subarray(at, newline).toString("utf8"));
    scan.lines.push({ at: scan.scanned + at, line });
    scan.bytes += Buffer.byteLength(line);
    at = newline + 1;
  }
  scan.scanned += at;
  scan.tail = bytesBefore(stream, scan.scanned);
  remember(copilotTurnScans, key, scan, 4);
  let kept = 0;
  for (const entry of copilotTurnScans.values()) kept += entry.bytes;
  for (const [other, entry] of copilotTurnScans) {
    if (kept <= COPILOT_TURN_SCAN_BYTES) break;
    copilotTurnScans.delete(other);
    kept -= entry.bytes;
  }
  return { start: scan.start, lines: scan.lines, partial: bytes.subarray(at).toString("utf8") };
}

/** Only native notification records name metadata files; quoted tool output names none. */
function collectSubagentIds(text: string, ids: Set<string>): void {
  if (!text.includes("<task-notification>")) return;
  for (const line of text.split("\n")) for (const notice of lineNotifications(line)) if (notice.agent) ids.add(notice.taskId);
}

function subagentsOnPage(path: string, text: string): ReadonlyMap<string, SubagentDetail> | undefined {
  const ids = new Set<string>();
  collectSubagentIds(text, ids);
  return ids.size === 0 ? undefined : subagentDetails(path, ids);
}

function omoAsksBefore(path: string, stream: TranscriptStream, before: number): Map<string, OmoAskState> {
  const open = new Map<string, OmoAskState>();
  const scan = clearScans.get(path);
  const events = scan?.source === "omo-transcript" ? scan.omoAsks?.events : undefined;
  if (!events) return open;
  for (const event of events) {
    if (event.at < stream.floor) continue;
    if (event.at >= before) break;
    if (event.kind === "close") open.delete(event.id);
    else open.set(event.id, event.kind);
  }
  return open;
}

function parseTurns(source: RecognizedConversation["source"], path: string, text: string, taskTitles?: Map<string, string>, noticed?: Set<string>, baseOffset?: number, omoAskIds?: Map<string, OmoAskState>): ConversationTurn[] {
  if (source === "copilot-transcript") return parseCopilotTranscript(text, Infinity, baseOffset);
  if (source === "grok-transcript") {
    try { return parseGrokTranscript(text, path); } catch (error) {
      if (error instanceof GrokUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  if (source === "agy-transcript") return parseAgyTranscript(text, path);
  if (source === "kimi-transcript") return parseKimiTranscript(text);
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
      : parseOmpTranscript(text, Infinity, ompReading(source, path, taskTitles, omoAskIds));
}

/** How the omp record fold reads a source, the same for a one-shot parse and a live one: pi and omo keep a
 * picture inline (an omo tool's display() or image read, #3420) and omp in its blob store, and the image
 * endpoint answers all three; gjc is read the same way but would carry image refs nothing answers, so it
 * names none. */
function ompReading(source: RecognizedConversation["source"], path: string, taskTitles?: Map<string, string>, omoAskIds?: Map<string, OmoAskState>) {
  return { images: source === "pi-transcript" || source === "cmd-transcript" || source === "omp-transcript" || source === "omo-transcript", blobs: source === "omp-transcript" ? ompBlobStore(path) : null, callIds: source === "gjc-transcript", taskTitles, ...(source === "omo-transcript" ? { omoAskIds: omoAskIds ?? new Map<string, OmoAskState>() } : {}) };
}

function turnBlobs(stream: TranscriptStream, source: StreamSource): string | null {
  const live = stream.files.at(-1)?.path;
  return source === "omp-transcript" && live !== undefined ? ompBlobStore(live) : null;
}

const INCREMENTAL_SOURCES = ["codex-transcript", "omp-transcript", "omo-transcript", "gjc-transcript", "claude-transcript", "pi-transcript", "cmd-transcript"] as const;
type IncrementalSource = typeof INCREMENTAL_SOURCES[number];
const incremental = (source: RecognizedConversation["source"]): source is IncrementalSource => (INCREMENTAL_SOURCES as readonly string[]).includes(source);

interface LiveTranscriptTurn {
  source: IncrementalSource;
  id: string;
  start: number;
  pageStart: number;
  prefixBoundary: string;
  scanned: number;
  boundary: string;
  contentHash?: string;
  parser: TranscriptParser;
  metadata: ConversationMetadata;
  fold: MetadataFold;
  /** the catalogs a pi window was looked up in: another dir, or an edited catalog, answers another window */
  piAgentDir?: string | null;
  catalogs?: string;
  subagents?: { ids: Set<string>; details: Map<string, SubagentDetail> };
}
const liveTranscriptTurns = new Map<string, LiveTranscriptTurn>();
const LIVE_TURN_ENTRIES = 8;
const LIVE_TURN_BYTES = 2 * TRANSCRIPT_WINDOW_BYTES;
const liveTurnBudget = (source: IncrementalSource) => source === "omo-transcript" || source === "gjc-transcript" ? "omo-gjc"
  : source === "pi-transcript" || source === "cmd-transcript" ? "pi-cmd" : "codex-omp-claude";

function incrementalLiveTurn(path: string, stream: TranscriptStream, source: IncrementalSource, start: number, before: SettledTurns): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  let cached = liveTranscriptTurns.get(path);
  if (cached && (cached.source !== source || cached.id !== stream.id || cached.start !== start
    || cached.pageStart !== before.start || cached.prefixBoundary !== before.tail || cached.piAgentDir !== before.piAgentDir || cached.catalogs !== before.catalogs || cached.scanned > stream.length
    || bytesBefore(stream, cached.scanned) !== cached.boundary)) cached = undefined;

  let details: Map<string, SubagentDetail> | undefined;
  if (cached?.subagents) {
    details = subagentDetails(path, cached.subagents.ids);
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
      : createOmpTranscriptParser(ompReading(source, path, new Map(before.taskTitles), source === "omo-transcript" ? new Map(before.omoAsks) : undefined));
    cached = { source, id: stream.id, start, pageStart: before.start, prefixBoundary: before.tail, scanned: start,
      boundary: bytesBefore(stream, start), parser, metadata: before.metadata, fold: { ...before.fold }, piAgentDir: before.piAgentDir, catalogs: before.catalogs, subagents };
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
    cached.metadata = parseConversationMetadata(text, source, cached.metadata, cached.piAgentDir, cached.fold);
    cached.scanned += complete;
    cached.boundary = bytesBefore(stream, cached.scanned);
  }
  if (digest) cached.contentHash = digest.update(bytes.subarray(0, complete)).digest("hex");
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
  return { turns: cached.parser.snapshot(tail), metadata: parseConversationMetadata(tail, source, cached.metadata, cached.piAgentDir, { ...cached.fold }) };
}

function metadataHead(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number): string {
  if (source === "codex-transcript") return readRange(path, 0, METADATA_HEAD_BYTES);
  const end = Math.min(start, stream.floor + METADATA_HEAD_BYTES);
  const scan = clearScans.get(path);
  const later = Object.values(scan?.settings ?? {})
    .filter((setting) => setting.end > end && setting.offset < start)
    .sort((a, b) => a.offset - b.offset)
    .filter((setting, index, settings) => index === 0 || setting.offset !== settings[index - 1]!.offset)
    .map((setting) => setting.line);
  const hidden = mergedRanges(stream.hidden ?? []);
  for (const records of Object.values(scan?.claude ?? {})) {
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

function liveTurns(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], start: number, starts: number[], piAgentDir?: string | null): { turns: ConversationTurn[]; metadata: ConversationMetadata } {
  const last = Math.max(start, starts[starts.length - 1] ?? start);
  const key = `${path}\0${source}\0${start}`;
  const catalogs = source === "pi-transcript" && piAgentDir !== null ? piCatalogVersion(piAgentDir)
    : source === "cmd-transcript" ? catalogVersion(cmdModelCatalogPath()) : undefined;
  let settled = settledTurns.get(key);
  if (!settled || settled.source !== source || settled.id !== stream.id || settled.end > last || bytesBefore(stream, settled.end) !== settled.tail || settled.piAgentDir !== piAgentDir || settled.catalogs !== catalogs) {
    const head = start > stream.floor ? metadataHead(path, stream, source, start) : "";
    let kept: SettledTurns | undefined;
    for (const [other, page] of settledTurns) {
      if (other.startsWith(`${path}\0${source}\0`) && page.source === source && page.id === stream.id && page.start < start && page.start > (kept?.start ?? -1)) kept = page;
    }
    const inherited = new Map(kept === undefined ? [] : kept.end <= start ? kept.taskTitles : kept.inherited);
    if (kept !== undefined) {
      const from = kept.end <= start ? kept.end : kept.start;
      const to = Math.min(start, kept.observedEnd);
      if (to > from) parseTurns(source, path, readStream(stream, from, to).toString("utf8"), inherited, undefined, from);
    }
    const fold: MetadataFold = { piProvider: null };
    settled = { source, id: stream.id, start, end: start, turns: [], metadata: parseConversationMetadata(`${head}
`, source, undefined, piAgentDir, fold), tail: bytesBefore(stream, start), taskTitles: new Map(inherited), omoAsks: source === "omo-transcript" ? omoAsksBefore(path, stream, start) : new Map(), noticed: new Set(), inherited, observedEnd: stream.length, piAgentDir, catalogs, fold };
  }
  if (settled.end < last) {
    const text = readStream(stream, settled.end, last).toString("utf8");
    const fold = { ...settled.fold };
    settled = { ...settled, end: last, turns: [...settled.turns, ...parseTurns(source, path, text, settled.taskTitles, settled.noticed, settled.end, source === "omo-transcript" ? settled.omoAsks : undefined)], metadata: parseConversationMetadata(text, source, settled.metadata, piAgentDir, fold), tail: bytesBefore(stream, last), fold };
  }
  settled.observedEnd = stream.length;
  rememberPage(settledTurns, key, settled, 8);
  if (incremental(source)) {
    const live = incrementalLiveTurn(path, stream, source, last, settled);
    return { turns: [...settled.turns, ...live.turns], metadata: live.metadata };
  }
  const text = readStream(stream, last, stream.length).toString("utf8");
  return { turns: [...settled.turns, ...parseTurns(source, path, text, new Map(settled.taskTitles), new Set(settled.noticed), last)], metadata: parseConversationMetadata(text, source, settled.metadata, piAgentDir, { ...settled.fold }) };
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
  const withinBudget = (["codex-omp-claude", "omo-gjc", "pi-cmd"] as const).every((name) => {
    const budget = turns.filter((turn) => liveTurnBudget(turn.source) === name);
    return budget.length <= LIVE_TURN_ENTRIES && budget.reduce((sum, turn) => sum + turn.scanned - turn.start, 0) <= LIVE_TURN_BYTES;
  });
  return { paths: [...liveTranscriptTurns.keys()], withinBudget };
}

let forgets = 0;
let forgottenFloor = 0;
const forgottenPanes = new Map<string, number>();
const forgottenSince = (paneId: string, at: number): boolean => forgottenFloor > at || (forgottenPanes.get(paneId) ?? 0) > at;

export function forgetTranscriptState(): void {
  forgottenFloor = ++forgets;
  forgottenPanes.clear();
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
  copilotTurnScans.clear();
  settledTurns.clear();
  liveTranscriptTurns.clear();
  transcriptRevisions.clear();
  uncheckedGrowths.clear();
  clearScans.clear();
  pictureChecks.clear();
  paneReads.clear();
  paneBindings.clear();
  copilotBindings.clear();
  forgetCopilotForeground();
  forgetAllCodexState();
  forgetAllPiIndexes();
  forgetGrokState();
  forgetAgyState();
  forgetDevinState();
  forgetHermesTranscriptState();
}

export function forgetPaneTranscriptState(paneId: string): void {
  forgottenPanes.delete(paneId);
  forgottenPanes.set(paneId, ++forgets);
  for (const [oldest, at] of forgottenPanes) {
    if (forgottenPanes.size <= PANE_READS_MAX) break;
    forgottenPanes.delete(oldest);
    forgottenFloor = Math.max(forgottenFloor, at);
  }
  const reads = paneReads.get(paneId);
  paneReads.delete(paneId);
  paneBindings.delete(paneId);
  copilotBindings.delete(paneId);
  launchedAgents.forget(paneId);
  forgetGjcPane(paneId);
  if (reads === undefined) return;
  const shared = (pick: (other: PaneReads) => Set<string>, value: string): boolean => [...paneReads.values()].some((other) => pick(other).has(value));
  for (const session of reads.sessions) if (!shared((other) => other.sessions, session)) writtenSessions.delete(session);
  for (const [key, session] of reads.devin) {
    if (![...paneReads.values()].some((other) => other.devin.has(key))) forgetDevinState(session.sessionId, session.cwd, session.dbPath);
  }
  for (const path of reads.paths) {
    if (shared((other) => other.paths, path)) continue;
    for (const key of [...cache.keys()]) if (key.startsWith(`${path}\0`)) cache.delete(key);
    transcriptRevisions.delete(path);
    uncheckedGrowths.delete(path);
    commandTranscripts.delete(path);
    liveScans.delete(path);
    forgetCopilotTurns(path);
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

export async function gjcTranscriptPath(paneId: string, cwd: string, home?: string, known?: KnownProcesses): Promise<string> {
  return (await gjcTranscriptFile(paneId, cwd, home, known)).path;
}

async function gjcTranscriptFile(paneId: string, cwd: string, home?: string, known?: KnownProcesses): Promise<{ path: string; identity: string }> {
  const found = known === undefined ? await gjcTranscriptFileForPane(paneId, cwd, home) : await gjcTranscriptFileForPane(paneId, cwd, home, { known });
  if (!found) throw new ConversationUnavailable("no_session_path");
  return found;
}

type KnownProcesses = ProcessInfo | null | undefined;

export async function paneRunsOmo(paneId: string, known?: KnownProcesses): Promise<boolean> {
  // pane.process_info wants `pane_id`; given `target` herdr answers for the
  // FOCUSED pane instead of erroring (live-verified 2026-09-21).
  // on Windows herdr names only the pane's shell, in a supplied list too: the OmO below it is added (withOmoDescendants)
  const supplied = known === undefined ? undefined : { process_info: known ?? undefined } as OmoProcessInfo;
  const info: { process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown; cwd?: unknown }[] } } | null = supplied === undefined ? await omoPaneProcessInfo(paneId)
    : process.platform === "win32" && typeof known?.shell_pid === "number" ? withOmoDescendants(supplied, await recentProcessTable(), processAlive) : supplied;
  const home = userHome();
  return (info?.process_info?.foreground_processes ?? []).some((process) =>
    omoProcessIdentity({
      pid: typeof process.pid === "number" ? process.pid : -1,
      argv: Array.isArray(process.argv) ? process.argv.map(String) : undefined,
      cwd: typeof process.cwd === "string" && process.cwd ? process.cwd : undefined,
    }, "", home) !== null,
  );
}

/**
 * The script an agent's npm package runs as its `bin`, which bunx and npx start under bun or node: omp's is
 * dist/cli.js in @oh-my-pi/pi-coding-agent (18.13.2 package.json `bin`), whose name is not omp (#2280).
 */
const NPM_ENTRIES: Partial<Record<string, RegExp>> = {
  omp: /(^|[\\/])node_modules[\\/]@oh-my-pi[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/i,
  // pi as its npm package runs it, and as gentle-shell runs its bundled pi (#4198)
  pi: PI_NPM_ENTRY,
};

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

const JOB_DEPTH = 6;
const JOB_PROCESSES = 256;

/**
 * Whether the shell `shellPid` holds `agent` as a stopped job (Ctrl+Z): a process below the shell in state T. herdr
 * names only the foreground process group, the shell's own while a job is stopped, as after the agent's exit
 * (live-checked, herdr 0.9.5), so this reads Linux's /proc: the children of each thread of the shell and of each
 * process below it (JOB_DEPTH levels, JOB_PROCESSES processes, each once), and each one's state and command line.
 * Ctrl+Z stops the job's whole process group, so the agent itself is stopped even when a launcher (`npx opencode`,
 * `sh -c 'opencode; …'`) is the shell's child. `pid`, when known, is the agent process the pane was verified with:
 * only it counts, not another stopped copy of the agent, and it is followed up its parents to the shell instead, so
 * a shell with more processes than the walk reads still finds it. Without /proc (macOS), or a process gone
 * meanwhile, nothing is found.
 */
export async function stoppedAgentJob(shellPid: number, agent: string, { pid = null, proc = "/proc" }: { pid?: number | null; proc?: string } = {}): Promise<boolean> {
  /** `pid (comm) state ppid …`: the command name may itself hold ") ", the fields follow its last one */
  const stat = async (process: string): Promise<{ name: string; state: string; parent: string } | null> => {
    const text = await readFile(`${proc}/${process}/stat`, "utf8").catch(() => "");
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open < 0 || close < open) return null;
    const [state = "", parent = ""] = text.slice(close + 2).split(" ");
    return { name: text.slice(open + 1, close), state, parent };
  };
  const isAgent = async (process: string, name: string): Promise<boolean> => {
    const argv = (await readFile(`${proc}/${process}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
    return programName(name) === agent || agentProcesses([{ argv, name }], agent).length > 0;
  };
  if (pid !== null) {
    const own = await stat(String(pid));
    if (own?.state !== "T" || !await isAgent(String(pid), own.name)) return false;
    let parent = own.parent;
    for (let depth = 0; depth < JOB_DEPTH; depth++) {
      if (parent === String(shellPid)) return true;
      const next = await stat(parent);
      if (next === null || next.parent === parent) return false;
      parent = next.parent;
    }
    return false;
  }
  const seen = new Set([String(shellPid)]);
  let level = [String(shellPid)];
  for (let depth = 0; depth < JOB_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      const threads = await readdir(`${proc}/${parent}/task`).catch(() => []);
      const lists = await Promise.all(threads.map((thread) => readFile(`${proc}/${parent}/task/${thread}/children`, "utf8").catch(() => "")));
      for (const child of lists.join(" ").split(/\s+/u).filter(Boolean)) {
        if (seen.has(child) || seen.size > JOB_PROCESSES) continue;
        seen.add(child);
        next.push(child);
        const found = await stat(child);
        if (found?.state === "T" && await isAgent(child, found.name)) return true;
      }
    }
    level = next;
  }
  return false;
}

export async function paneProcessRoots(paneId: string, agent: string | null | undefined): Promise<{
  omo: { agentDir: string | null; pluginDir: string | null; held: boolean } | null;
  environ: string[] | null;
  pid: number | null;
  cwd: string | null;
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
  const matched = agent && ["claude", "codex", "omp", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy", "copilot", "letta"].includes(agent)
    ? agentProcesses(foreground, agent)[0] ?? null : null;
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
        } catch {}
      }
    }
    if (!pluginDir) {
      const executable = Bun.which("omo");
      if (executable) {
        try { pluginDir = directory(nodePath.join(nodePath.dirname(nodePath.dirname(realpathSync(executable))), "plugin")); }
        catch {}
      }
    }
    return { omo: { agentDir, pluginDir, held: identity.held }, environ: processEnviron(process.pid), pid: process.pid, cwd: process.cwd || null, ...(processes ? { processes } : {}) };
  }
  return { omo: null, environ: matched ? processEnviron(matched.pid) : null, pid: matched?.pid ?? null, cwd: matched?.cwd || null, ...(processes ? { processes } : {}) };
}

/**
 * herdr labels an omo pane `pi` while it waits and `claude` while omo's claude-sdk child
 * runs, so the sidebar showed another agent's mark, and one that changed as omo worked.
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

/**
 * The local terminal an `hc attach <t>` in front shows, by the address hc itself reports for it: the
 * word typed must be that address, never a name hc resolves to another terminal, nor another
 * machine's terminal (whose pids name nothing here).
 */
function hcAttachWord(argv: readonly string[] | null | undefined): string | null {
  if (!argv || argv.length !== 3 || argv[1] !== "attach") return null;
  const program = programName(argv[0]!);
  return (program === "hc" || program === "herdr-core") && /^[A-Za-z0-9]+$/.test(argv[2]!) ? argv[2]! : null;
}

/** A process's environment as it started (Linux /proc, macOS sysctl), the first value of each name; null when it cannot be read. */
function startEnvironment(pid: number): Record<string, string> | null {
  const entries = process.platform === "linux" ? processEnviron(pid) : process.platform === "darwin" ? darwinProcess.environment(pid)?.split("\0") ?? null : null;
  const env: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const at = entry.indexOf("=");
    if (at > 0 && !Object.hasOwn(env, entry.slice(0, at))) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return Object.keys(env).length === 0 ? null : env;
}

/**
 * Whether an `hc attach` client reaches the core this server serves: a client goes to whatever core its
 * own environment names (HC_SOCKET, HC_SESSION, its runtime and config folders), where the terminal
 * numbers (t1, t2...) repeat. Its socket, found from that environment as hc finds it, must be this
 * server's core's; an environment that cannot be read follows nothing.
 */
function reachesOwnCore(client: number): boolean {
  const env = startEnvironment(client);
  if (env === null) return false;
  const theirs = coreSocket({ env }).path;
  const ours = coreSocketPath();
  if (theirs === ours) return true;
  try { return realpathSync(theirs) === realpathSync(ours); } catch { return false; }
}

/**
 * The Claude processes in a pane's foreground (`known`: herdr's answer already read); none when herdr cannot say.
 * On Windows herdr and herdr-core name only the shell in front, even while Claude runs in it, and
 * herdr-core reports no session for it: the Claude below the shell is taken from the process table (#2896).
 * Elsewhere herdr-core names only the first process of the foreground job, where herdr names them all: the one
 * Claude below it in the job (a launcher's child), or, in a tab running `hc attach <t>`, the Claude of the
 * terminal it shows (#3009). `viewed`: the terminal such a tab shows, which is followed no further.
 */
async function claudeProcesses(paneId: string, known?: KnownProcesses, viewed = false): Promise<{ pid: number; name?: string; argv0?: string; argv?: string[] }[]> {
  let info: KnownProcesses;
  if (known !== undefined) info = known;
  else {
    try {
      info = (await herdrRpc<{ process_info?: ProcessInfo }>("pane.process_info", { pane_id: paneId })).process_info ?? null;
    } catch { return []; }
  }
  const front = (info?.foreground_processes ?? []).map(({ pid, name, argv0, argv }) => ({
    pid, name, ...(typeof argv0 === "string" ? { argv0 } : {}), ...(Array.isArray(argv) ? { argv } : {}),
  })).filter(isClaudeProcess);
  if (viewed && info?.pane_id !== paneId) return [];
  if (front.length > 0) return front;
  const shell = info?.shell_pid;
  if (process.platform === "win32") return typeof shell === "number" ? (await windowsShellClaude(shell).catch(() => null)) ?? [] : [];
  const leader = info?.foreground_processes?.[0];
  if (capabilities().foreground !== "leader" || leader === undefined || typeof leader.pid !== "number") return [];
  const word = viewed ? null : hcAttachWord(leader.argv);
  if (word !== null) return reachesOwnCore(leader.pid) ? claudeProcesses(word, undefined, true) : [];
  return (await jobClaude(leader.pid)) ?? [];
}

export async function claudePanePid(pane: HerdrPane): Promise<number | null> {
  const processes = await claudeProcesses(pane.pane_id);
  return processes.length === 1 ? processes[0]!.pid : null;
}

/**
 * Claude's transcript: Herdr's hook, or a unique live Claude's native PID record, in the config dir
 * of the pane's Claude process (a launcher can give each environment its own CLAUDE_CONFIG_DIR). A
 * `claude attach <id|name>` keeps no PID record: only the state of the job it opened, found as Claude
 * finds it, names the session it shows, never the hook's.
 */
async function claudeTranscriptPath(paneId: string, cwds: readonly (string | null | undefined)[], onProcess?: (pid: number, attach: boolean) => void, known?: KnownProcesses, proofs?: Map<string, string>): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: paneId });
  let session = info.agent.agent_session?.value;
  const home = userHome();
  const facts: KnownProcesses = known !== undefined ? known
    : await herdrRpc<{ process_info?: ProcessInfo }>("pane.process_info", { pane_id: paneId }).then((answer) => answer.process_info ?? null, () => null);
  const processes = await claudeProcesses(paneId, facts);
  const only = processes.length === 1 ? processes[0] : undefined;
  let processDir: string | null = null;
  try {
    // no Claude in the whole job herdr names: a wrapper's hint may name its store, and the session is then only the
    // one reported (#3931). herdr-core names the leader alone, and an empty jobClaude may be two Claudes: no hint there
    processDir = only ? await processClaudeConfigDir(only.pid, only.argv ?? [only.argv0 ?? only.name ?? ""], home)
      : processes.length === 0 && capabilities().foreground === "job" ? await hintedClaudeConfigDir(facts?.foreground_processes ?? []) : null;
  } catch (error) {
    // two stores claim the process: ~/.claude would be a guess, maybe another account's session (#586)
    if (error instanceof AmbiguousClaudeStore) throw new ConversationUnavailable("no_session_id");
    throw error;
  }
  const configDir = processDir || defaultClaudeConfigDir(home);
  const attach = only ? await claudeAttachSession(configDir, only.pid, only.argv) : null;
  if (only) onProcess?.(only.pid, attach !== null);
  // the session the process's own PID record names, also beside the hook's: a /branch can leave the hook's behind (#2020);
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
  const path = await claudeTranscriptFile(home, session, cwds, configDir, live, proofs);
  // Claude writes the file with its first message: until then the session it reports holds nothing
  if (!path) throw new ConversationNotStarted(session, "claude-transcript");
  return path;
}

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

let betweenAuthorization: ((stage: "before" | "after") => void) | null = null;

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

/**
 * omp's transcript: herdr hands over the absolute path, accepted only inside the store the pane's
 * omp processes write to (omp.ts ompPaneRoute, from their own argv and environment), as a session
 * of the pane's directory; else the pane's omp process names it. Only where herdr shows no omp
 * process, and on Windows, which shows no process's environment, is herdr's path held to the
 * user's own default and profile stores instead.
 * `identity`: the authorized file's exact dev:ino (authorizedTranscript), so later reads can be held to it.
 */
export async function ompTranscriptPath(paneId: string, cwd: string, known?: KnownProcesses): Promise<{ path: string; blobs: string | null; identity?: string }> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: unknown; value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  const path = session?.kind === "path" && typeof session.value === "string" ? session.value : null;
  const home = userHome();
  let route = process.platform === "win32" ? null : await ompPaneRoute(paneId, known);
  if (route === null && known != null && process.platform !== "win32") route = await ompPaneRoute(paneId);
  if (route === "unproved") throw new ConversationUnavailable("no_session_path");
  const store = route === null ? ompSessionStore(path, home) : path === null ? null : ompRouteStore(route, path);
  if (path !== null && store !== null) {
    // omp names its session file at start and writes it with the first answer
    const unwritten = unwrittenSession(path, store);
    if (unwritten !== null) throw new ConversationNotStarted(unwritten.id, "omp-transcript", unwritten.path);
    // the check above is lexical: a link out of the store is no transcript of this pane
    const inStore = authorizedTranscript(path, store);
    if (inStore !== null && (route === null || ompRouteOwns(route, inStore.path, cwd))) return { ...ompAuthorizedTranscript(inStore), identity: inStore.identity };
    if (route === null) throw new ConversationUnavailable("no_session_path");
  }
  const held = route === null ? null : ompRouteTranscript(await ompHeldOpen(route, capabilities().agents === "reported"), cwd);
  if (held === null) throw new ConversationUnavailable("no_session_path");
  const authorized = authorizedTranscript(held, route!.layout.sessions);
  return authorized === null ? { path: held, blobs: null } : { ...ompAuthorizedTranscript(authorized), identity: authorized.identity };
}

async function copilotTranscriptPath(pane: HerdrPane, panes: readonly HerdrPane[], previousClaims?: ReadonlySet<string>, peerInfo?: Map<string, Awaited<ReturnType<typeof paneProcessInfo>> | null>): Promise<{ path: string; binding: string; peerClaims: ReadonlySet<string> }> {
  const report = pane.agent_session;
  let peerClaims: Promise<ReadonlySet<string>> | undefined = previousClaims === undefined ? undefined : Promise.resolve(previousClaims);
  const gatherPeerClaims = async (): Promise<Set<string>> => {
    const claims = new Set<string>();
    await Promise.all(panes.map(async (peer) => {
      if (peer.pane_id === pane.pane_id || peer.agent !== "copilot") return;
      const cached = peerInfo?.has(peer.pane_id) === true;
      const info = cached ? peerInfo!.get(peer.pane_id) : await paneProcessInfo(peer.pane_id).catch(() => null);
      peerInfo?.set(peer.pane_id, info ?? null);
      const processes = agentProcesses(info?.foreground_processes ?? [], "copilot");
      // A cached peer process that has exited may have been replaced by one we never asked about.
      if (cached && processes.some((entry) => typeof entry.pid === "number" && !processAlive(entry.pid))) throw new ConversationUnavailable("no_session_path", undefined, "copilot_peer_process_replaced");
      if (processes.length === 1 && typeof processes[0]?.pid === "number") {
        const api = await readCopilotForeground(processes[0].pid);
        if (api.state === "selected") {
          claims.add(api.sessionId);
          return;
        }
        const live = copilotProcessSession(processEnviron(processes[0].pid), processes[0].argv ?? [], processes[0].pid);
        if (live?.logged) {
          claims.add(live.sessionId);
          return;
        }
      }
      if (peer.agent_session?.agent === "copilot" && peer.agent_session.kind === "id" && typeof peer.agent_session.value === "string") claims.add(peer.agent_session.value);
    }));
    return claims;
  };
  const claimedByPeer = async (session: string): Promise<boolean> => (await (peerClaims ??= gatherPeerClaims())).has(session);
  if (pane.agent !== "copilot") {
    throw new ConversationUnavailable("no_session_id", undefined, "copilot_report_invalid");
  }
  // A failed RPC does not prove an ownership change. Retry that read once; an answered
  // empty/conflicting process set still fails closed, as does a failed retry.
  // Nor does a process herdr lists without its argv: herdr (0.9.3) leaves that out while the process is
  // in uninterruptible sleep or exiting, so the set is asked for once more. A set still unread cannot
  // say which processes are Copilot or which store their arguments name, so it fails closed.
  const ask = () => paneProcessInfo(pane.pane_id).catch(() => paneProcessInfo(pane.pane_id)).catch(() => null);
  const unread = (answer: Awaited<ReturnType<typeof ask>>) => answer?.foreground_processes?.some((entry) => !entry.argv?.length) === true;
  const first = await ask();
  const info = unread(first) ? await ask() : first;
  if (info === null) throw new ConversationUnavailable("no_session_path", undefined, "copilot_process_lookup_failed");
  if (unread(info)) throw new ConversationUnavailable("no_session_path", undefined, "copilot_process_set_unproved");
  const processes = agentProcesses(info?.foreground_processes ?? [], "copilot");
  const foreground = processes[0];
  if (process.platform !== "linux" || ![1, 2].includes(processes.length) || typeof foreground?.pid !== "number") {
    throw new ConversationUnavailable("no_session_path", undefined, "copilot_process_set_unproved");
  }
  if (processes.length === 1) {
    const api = await readCopilotForeground(foreground.pid);
    if (api.state === "selected") {
      const path = copilotApiTranscript(api.sessionId, processEnviron(foreground.pid), foreground.argv ?? []);
      if (path === null) throw new ConversationUnavailable("no_session_path", undefined, "copilot_api_transcript_unproved");
      peerClaims = undefined;
      if (await claimedByPeer(api.sessionId)) throw new ConversationUnavailable("no_session_path", undefined, "copilot_peer_conflict");
      const current = await readCopilotForeground(foreground.pid);
      if (current.state !== "selected" || current.binding !== api.binding || current.sessionId !== api.sessionId) {
        throw new ConversationUnavailable("no_session_path", undefined, "copilot_api_foreground_changed");
      }
      return { path, binding: `api:${foreground.pid}:${api.binding}`, peerClaims: await peerClaims! };
    }
    if (api.diagnostic !== "not_opted_in") throw new ConversationUnavailable("no_session_path", undefined, `copilot_api_${api.diagnostic}`);
  }
  // Copilot's API answered that it was started without --ui-server; with it, Chat would ask it which
  // session it shows rather than prove that from files, so any failure below may be helped by the flag.
  const hint = processes.length === 1 ? "copilot_ui_server" as const : undefined;
  if (report != null && (report.agent !== "copilot" || report.kind !== "id"
    || report.source !== "herdr:copilot" || typeof report.value !== "string" || !SESSION_ID.test(report.value))) {
    throw new ConversationUnavailable("no_session_id", undefined, "copilot_report_invalid", hint);
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
  const resolution = readCopilotProcessSession(environment, argv, foreground.pid);
  const selected = resolution.session;
  const logged = selected?.logged ? selected : null;
  const peerConflict = logged !== null && await claimedByPeer(logged.sessionId);
  if (logged !== null && !peerConflict) {
    const path = copilotTranscriptFile(logged.sessionId, selected);
    if (path !== null && nodePath.basename(nodePath.dirname(path)) === logged.sessionId)
      return { path, binding: `${foreground.pid}:${logged.generation}`, peerClaims: await peerClaims! };
  }
  if (report != null) {
    if (await claimedByPeer(report.value)) throw new ConversationUnavailable("no_session_id", undefined, "copilot_peer_conflict", hint);
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
  const diagnostic = resolution.diagnostic ?? (peerConflict ? "copilot_peer_conflict"
    : logged !== null ? "copilot_transcript_unreadable"
    : report == null ? "copilot_report_missing"
    : selected?.sessionId !== report.value ? "copilot_report_mismatch" : "copilot_transcript_unreadable");
  throw new ConversationUnavailable(copilotExplicitResume(argv) ? "copilot_resume_unknown" : report == null ? "no_session_id" : "no_session_path",
    undefined, diagnostic, hint);
}

type ResolvedTranscript =
  | ({ path: string; codexHome?: string; agy?: AgyStore; piAgentDir?: string | null; ompBlobs?: string | null;
    ompFile?: string;
    piFile?: string;
    gjcFile?: string;
    omoFile?: string;
    claudeFile?: string;
    codexFile?: string; letta?: { store: string; agent: string; conversation: string } } & (
    | { source: Exclude<StreamSource, "copilot-transcript"> }
    | { source: "copilot-transcript"; binding: string; peerClaims: ReadonlySet<string> }
  ))
  | { source: "opencode-transcript"; path: string; session: string }
  | { source: "hermes-transcript"; path: string; sessionId: string }
  | ({ source: "dsh-transcript" } & DshTranscript)
  | ({ source: "kiro-transcript" } & KiroTranscript);

export type NativeTranscript =
  | ResolvedTranscript
  | { source: "acp"; path: string }
  | { source: "devin-transcript"; path: string; session: string; cwd: string; binding?: string };

/**
 * The pane's foreground processes the dsh reader looks at: herdr names every process of the job, herdr-core
 * only its first, so there the dsh processes below it in the job join it (#3939), as for Claude (#3009).
 */
async function dshForeground(known: KnownProcesses): Promise<{ foreground_processes?: { pid?: number; argv?: unknown }[] } | null | undefined> {
  const front = known?.foreground_processes ?? [];
  const leader = front[0];
  if (capabilities().foreground !== "leader" || leader === undefined || typeof leader.pid !== "number") return known;
  if (front.some((entry) => Array.isArray(entry.argv) && isDshProcess(entry.argv))) return known;
  return { foreground_processes: [...front, ...await jobDsh(leader.pid)] };
}

/**
 * herdr's agent label follows the pane's foreground processes, so an omo pane reads as `pi` while it waits and
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
    const foreground = info?.process_info?.foreground_processes ?? [];
    const running = foreground.some((process) =>
      isGjcProcess(Array.isArray(process.argv) ? process.argv.map(String) : []),
    );
    if (running || await gjcPidUnderShell(info?.process_info?.shell_pid)) agent = "gjc";
    else if (foreground.some((process) => Array.isArray(process.argv) && isDshProcess(process.argv))) {
      agent = "dsh";
      if (known === undefined) known = (info?.process_info as KnownProcesses) ?? null;
    }
    // herdr labels Kiro from its screen: before that shows, its chat TUI in front says the same
    else if (foreground.some((process) => Array.isArray(process.argv) && isKiroChatProcess(process.argv))) {
      agent = "kiro";
      if (known === undefined) known = (info?.process_info as KnownProcesses) ?? null;
    }
    else if (await paneCodexProcess(paneId, (info?.process_info as ProcessInfo | undefined) ?? null) !== null) agent = "codex";
  }
  if ((agent === "muse" || agent === "letta" || agent === "dsh" || agent === "dsh-tui" || agent === "kiro") && known === undefined) known = (await paneProcessInfo(paneId).catch(() => undefined)) ?? null;
  if (await paneRunsOmo(paneId, known)) {
    const found = await omoTranscriptPath(paneId, cwd, panes);
    return { source: "omo-transcript", path: found.path, ...(found.identity === undefined ? {} : { omoFile: found.identity }) };
  }
  // omp and GJC can change their own cwd without changing the pane's shell directory; their
  // session headers name the one they run in
  const sessionCwd = typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0 ? pane.foreground_cwd : cwd;
  try {
    if (agent === "dsh" || agent === "dsh-tui") return { source: "dsh-transcript", ...await resolveDshTranscript(await dshForeground(known)) };
    if (agent === "kiro") return { source: "kiro-transcript", ...await resolveKiroTranscript(known) };
    if (agent === "copilot") return { source: "copilot-transcript", ...await copilotTranscriptPath(pane, panes ?? [pane]) };
    if (agent === "grok") {
      const found = await resolveGrokStore(pane, grokHome);
      if (!found) throw new ConversationUnavailable("no_session_path");
      return { source: "grok-transcript", path: found };
    }
    if (agent === "muse") {
      const path = await resolveMuseSession(pane, museData, known).catch((error: unknown) => {
        if (error instanceof MuseLogUnreadable) throw new ConversationUnavailable("transcript_unreadable");
        throw error;
      });
      if (path === null) throw new ConversationUnavailable("no_session_path");
      return { source: "muse-transcript", path };
    }
    if (agent === "letta" && pane.agent === "letta") {
      const found = await resolveLettaTranscript(pane, panes ?? [pane], known);
      if (found === null) throw new ConversationUnavailable("no_session_path");
      return { source: "letta-transcript", path: found.path, letta: { store: found.store, agent: found.agent, conversation: found.conversation } };
    }
    if (agent === "agy") {
      const found = await resolveAgyStore(pane);
      if (!found) throw new ConversationUnavailable("no_session_path");
      let transcriptExists: boolean;
      try { transcriptExists = !!statSync(found.path, { throwIfNoEntry: false }); }
      catch { throw new ConversationUnavailable("transcript_missing"); }
      if (!transcriptExists) {
        if (writtenSessions.has(`agy-transcript\0${found.path}`)) throw new ConversationUnavailable("transcript_missing");
        const catalog = await agyCatalogOffThread(found.path);
        const firstTurn = pane.agent_status === "working" && (catalog.size === 0 || (catalog.size === 1 && catalog.has(0)));
        if ((catalog.size !== 0 && !firstTurn) || !sameAgyStore(found, await resolveAgyStore(pane))) throw new ConversationUnavailable("transcript_missing");
        throw new ConversationNotStarted(found.session, "agy-transcript", found.path);
      }
      return { source: "agy-transcript", path: found.path, agy: found };
    }
    if (agent === "codex") {
      const { home, placed } = await paneCodexHomePlaced(paneId, codexHome, known);
      const proofs = new Map<string, string>();
      const path = await codexTranscriptPath(paneId, cwd, home, panes, !placed, placed && !codexHome, proofs);
      if (!path) throw new ConversationUnavailable("no_session_path");
      const codexFile = proofs.get(path);
      return { source: "codex-transcript", path, codexHome: home, ...(codexFile === undefined ? {} : { codexFile }) };
    }
    if (agent === "claude") {
      const proofs = new Map<string, string>();
      const path = await claudeTranscriptPath(paneId, [cwd, pane.foreground_cwd], undefined, known, proofs);
      const claudeFile = proofs.get(path);
      return { source: "claude-transcript", path, ...(claudeFile === undefined ? {} : { claudeFile }) };
    }
    if (agent === "omp") {
      const authorized = await ompTranscriptPath(paneId, sessionCwd, known);
      return { source: "omp-transcript", path: authorized.path, ompBlobs: authorized.blobs, ompFile: authorized.identity };
    }
    if (agent === "gjc") {
      const found = await gjcTranscriptFile(paneId, sessionCwd, undefined, known);
      return { source: "gjc-transcript", path: found.path, gjcFile: found.identity };
    }
    if (agent === "pi") {
      const found = await piTranscriptPath(paneId, undefined, known === undefined ? {} : { processes: known?.foreground_processes ?? [] });
      if (found === null) throw new ConversationUnavailable("no_session_path");
      if ("unwritten" in found) throw new ConversationNotStarted(found.unwritten.id, "pi-transcript", found.unwritten.path);
      return { source: "pi-transcript", path: found.path, piAgentDir: found.agentDir, piFile: found.identity };
    }
    if (agent === "cmd") {
      const found = await cmdTranscriptPath(paneId);
      if (found === null) throw new ConversationUnavailable("no_session_path");
      if ("unwritten" in found) throw new ConversationNotStarted(found.unwritten.id, "cmd-transcript", found.unwritten.path);
      return { source: "cmd-transcript", path: found.path };
    }
    if (agent === "opencode") {
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
    if ((agent === "kimi" || agent === "kimi-code") && pane.agent === "kimi") {
      const path = await kimiTranscriptPathForPane(pane);
      if (path === null) throw new ConversationUnavailable("no_session_path");
      return { source: "kimi-transcript", path };
    }
    throw new ConversationUnavailable("no_recognized_transcript");
  } catch (error) {
    if (error instanceof AgyUnavailable) throw new ConversationUnavailable("transcript_missing");
    if (!(error instanceof ConversationUnavailable) || !(await paneRunsOmo(paneId, known))) throw error;
    const found = await omoTranscriptPath(paneId, cwd, panes);
    return { source: "omo-transcript", path: found.path, ...(found.identity === undefined ? {} : { omoFile: found.identity }) };
  }
}

async function omoTranscriptPath(paneId: string, cwd: string, panes?: HerdrPane[]): Promise<{ path: string; identity?: string }> {
  const session = await omoSessionForPane(paneId, cwd, panes ?? (await sessionSnapshot()).panes);
  if (session.pending !== null) throw new ConversationNotStarted(session.pending);
  if (!session.path) throw new ConversationUnavailable("no_session_path");
  return { path: session.path, ...(session.identity === undefined ? {} : { identity: session.identity }) };
}

export async function paneTranscript(paneId: string, codexHome?: string, snapshot?: SessionSnapshot, devinDbPath?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string, known?: KnownProcesses): Promise<NativeTranscript> {
  const socket = herdrSocketPath();
  const panes = (snapshot ?? await sessionSnapshot()).panes;
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined) throw new ConversationUnavailable("pane_not_found");
  const child = coreAcp()?.forPane(paneId);
  if (child) return { source: "acp", path: child.client.history.path };
  if (typeof pane.cwd !== "string" || pane.cwd.length === 0) throw new ConversationUnavailable("no_recognized_transcript", undefined, pane.agent ? "agent_cwd_missing" : undefined);

  if (pane.agent === "devin" && !(await paneRunsOmo(paneId, known))) {
    const cwd = pane.foreground_cwd || pane.cwd;
    const storePath = devinDbPath ?? defaultDevinDbPath();
    const info = known !== undefined ? { process_info: known ?? undefined } : await herdrRpc<{ process_info?: { foreground_processes?: { pid?: number; argv?: unknown }[] } }>(
      "pane.process_info", { pane_id: paneId },
    ).catch(() => null);
    if (herdrSocketPath() !== socket) throw new ConversationUnavailable("no_session_id");
    const processes = (info?.process_info?.foreground_processes ?? []).filter((process) =>
      Array.isArray(process.argv) && process.argv.every((arg) => typeof arg === "string") &&
      isDevinProcess(process.argv as string[]) && process.argv[1] !== "acp",
    );
    if (processes.length > 1) throw new ConversationUnavailable("transcript_missing");
    if (processes.length === 1) {
      const foreground = processes[0]!;
      // the live lock names a fresh session; where there is no lock to read (no session_locks in an
      // older Devin, a symlinked store, no lock taken yet) an explicitly named session reads as
      // before. Evidence that is read and does not hold up (two locks, a foreign owner) refuses, and
      // so does a lock naming another session than the pane names (devinSessionForPane)
      let proof: DevinLockProof | undefined;
      if (process.platform === "linux" && typeof foreground.pid === "number") {
        try { proof = devinLockProof(foreground.pid, storePath); } catch (error) {
          if (!(error instanceof DevinLockMissing)) throw error;
        }
      }
      const session = devinSessionForPane(pane, panes, foreground.argv as string[], proof?.session);
      if (proof !== undefined) {
        const again = devinLockProof(foreground.pid!, storePath);
        if (again.session !== proof.session || again.binding !== proof.binding) throw new ConversationUnavailable("no_session_id");
      }
      return noteBinding(paneId, { source: "devin-transcript", path: storePath, session, cwd, binding: JSON.stringify([socket, proof?.binding ?? null]) });
    }
  }

  return noteBinding(paneId, await resolveTranscript(pane, pane.cwd, codexHome, panes, opencodeDb, hermesHome, grokHome, museData, known));
}

const AGY_WRITE_RACE_MS = 5000;

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

/** Read-only, same-user files only. The notes hc typed into the pane read as notices (withHcNotes). */
export async function paneConversation(...args: Parameters<typeof readPaneConversation>): Promise<RecognizedConversation> {
  const conversation = await readPaneConversation(...args);
  return conversation.source === "acp" ? conversation : { ...conversation, turns: withHcNotes(conversation.turns) };
}

async function readPaneConversation(paneId: string, codexHome?: string, page: ConversationPage = {}, devinDbPath?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string): Promise<RecognizedConversation> {
  const socket = herdrSocketPath();
  const snapshot = await sessionSnapshot();
  let resolved: NativeTranscript;

  // no transcript states the model yet: the agent's own screen does (start-screen.ts). A screen
  // that cannot be read leaves it unknown. omp follows its transcript only: catalog discovery
  // can refresh the CLI's OAuth credentials and is never initiated by the bridge. Only the live
  // screen counts (bottomViewport): history can show an older frame of the agent, with a model it
  // no longer runs.
  const screenMetadata = async (source: RecognizedConversation["source"]): Promise<ConversationMetadata> =>
    startScreenMetadata(source, await bottomViewport(paneId));
  const notBegun = async (source: RecognizedConversation["source"], id: string, read?: ConversationMetadata, fromScreen = false): Promise<RecognizedConversation> => {
    const screen = fromScreen || readsStartScreen(source);
    // agy's greeting names a model only from the frame its unused session was proven on (passed in
    // as `read`): a later frame can already show another conversation, or another agy's.
    const metadata = read ?? (screen && source !== "agy-transcript" ? await screenMetadata(source) : { model: null, reasoning_effort: null });
    return { source, turns: [], metadata, ...(screen ? { screen: true as const } : {}), cursor: null, history_id: id, version: answerVersion(id, `${metadata.model}\0${metadata.reasoning_effort}`) };
  };

  const onNotStarted = async (error: ConversationNotStarted): Promise<RecognizedConversation> => {
    if (writtenSessions.has(`${error.source}\0${error.identity}`)) throw new ConversationUnavailable("transcript_missing");
    if (page.before !== undefined || page.since !== undefined || page.from !== undefined) throw new HistoryChanged();
    // Claude writes its file with the first message, so at work with none it has no turn yet: a
    // /clear reports working for a moment (#2550)
    const status = snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
    if ((status === "working" && error.source !== "claude-transcript" && error.source !== "agy-transcript") || status === "blocked") throw error;
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
    if (pane.agent === "copilot") {
      const shown = copilotBindings.get(paneId);
      const reported = pane.agent_session?.value;
      const moved = copilotRecoverable(error.diagnostic) && page.history_id !== undefined
        && (shown === undefined || !page.history_id.startsWith(shown.prefix) || (reported != null && reported !== shown.session));
      const waits = page.history_id !== undefined && copilotRecoverable(error.diagnostic) && !moved;
      if ((page.before !== undefined || page.since !== undefined || page.from !== undefined) && !waits) throw new HistoryChanged();
      throw moved ? new ConversationUnavailable(error.message, error.screen, "copilot_report_mismatch", error.hint) : error;
    }
    const launch = launchedAgents.notBegun(paneId, pane.agent_status);
    if (launch === null) {
      if (pane.agent === "codex" && page.before === undefined && page.since === undefined && page.from === undefined) {
        const text = await bottomViewport(paneId);
        const screen = startScreenMetadata("codex-transcript", text);
        if (error.message === "no_session_path" && screen.model !== null && pane.agent_status !== "working" && pane.agent_status !== "blocked") {
          const fresh = await codexFreshSession(paneId, [pane.cwd ?? "", pane.foreground_cwd ?? ""], codexHome, text);
          if (fresh !== null) return await notBegun("codex-transcript", fresh, screen);
        }
        if (screen.model !== null) throw new ConversationUnavailable(error.message, screen);
      }
      if (pane.agent === "agy" && error.message === "no_session_path" && page.before === undefined && page.since === undefined && page.from === undefined && pane.agent_status !== "working" && pane.agent_status !== "blocked") {
        // the model comes from the frame proven to be the unused start screen, not a later read
        const text = await bottomViewport(paneId);
        const fresh = await agyFreshSession(pane, text);
        if (fresh !== null) return await notBegun("agy-transcript", fresh, startScreenMetadata("agy-transcript", text));
      }
      // an OpenCode at its home screen, which herdr reports no session for until the first prompt (#3600)
      if (pane.agent === "opencode" && pane.agent_session == null && error.message === "no_session_id" && page.before === undefined && page.since === undefined && page.from === undefined && pane.agent_status !== "working" && pane.agent_status !== "blocked") {
        const fresh = await opencodeFreshSession(pane, await bottomViewport(paneId), opencodeDb ?? opencodeDatabasePath());
        if (fresh !== null) return await notBegun("opencode-transcript", fresh, { model: null, reasoning_effort: null }, true);
      }
      throw error;
    }
    if (page.before !== undefined || page.since !== undefined || page.from !== undefined) throw new HistoryChanged();
    return await notBegun(launch.source, launch.historyId);
  }
  if (resolved.source === "acp") {
    const child = coreAcp()?.forPane(paneId);
    if (!child || child.client.history.path !== resolved.path) throw new HistoryChanged();
    return child.client.history.page(page);
  }
  if (resolved.source === "dsh-transcript") {
    rememberPaneRead(paneId, resolved.path);
    return await dshConversation(resolved, page);
  }
  if (resolved.source === "kiro-transcript") {
    rememberPaneRead(paneId, resolved.path);
    return await kiroConversation(resolved, page);
  }
  if (resolved.source === "devin-transcript") {
    try {
      if (herdrSocketPath() !== socket) throw new ConversationUnavailable("no_session_id");
      const answer = devinConversation(resolved.session, resolved.cwd, page, resolved.path);
      const fresh = await paneTranscript(paneId, codexHome, undefined, devinDbPath, opencodeDb, hermesHome, grokHome, museData);
      if (fresh.source !== "devin-transcript" || fresh.session !== resolved.session || fresh.path !== resolved.path
        || fresh.cwd !== resolved.cwd || fresh.binding !== resolved.binding) throw new ConversationUnavailable("no_session_id");
      rememberPaneDevin(paneId, resolved.session, resolved.cwd, resolved.path);
      return answer;
    } catch (error) {
      if (error instanceof DevinHistoryUnavailable) throw new ConversationUnavailable("transcript_missing");
      throw error;
    }
  }
  if (resolved.source === "opencode-transcript") {
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
  const transcript = resolved;
  const forgetsBefore = forgets;
  const live = (): boolean => herdrSocketPath() === socket && !forgottenSince(paneId, forgetsBefore);
  let history = null as string | null;
  let prefix = null as string | null;
  // the Agy ledger readSettled authorized (its page handle's file): every read of it below reads only that file
  let ledger = undefined as { dev: number; ino: number } | undefined;
  let answer: RecognizedConversation;
  try {
    const settled = await readSettled({ path: transcript.path, checkWindow: transcript.source === "muse-transcript", live }, () => {
      rememberPaneRead(paneId, transcript.path);
      if (transcript.source === "agy-transcript") {
        const opened = fstatSync(pageFile!.fd);
        ledger = { dev: opened.dev, ino: opened.ino };
        return null;
      }
      history = transcript.source === "copilot-transcript" ? copilotHistoryIdentity(transcript.path) : null;
      prefix = history !== null && transcript.source === "copilot-transcript" ? copilotPrefix(paneId, `${transcript.binding}\0${history}`, transcript.path) : null;
      return transcriptPage(transcript.source, transcript.path, prefix === null ? page : copilotPage(page, prefix), transcript.codexHome ?? codexHome, transcript.piAgentDir);
    });
    if (settled === null) throw new ConversationUnavailable("no_session_id");
    const readAgy = () => agyTranscriptPage(resolved.path, page, resolved.codexHome ?? codexHome, ledger);
    answer = settled.value ?? await readAgy().catch((error) => {
      if (error instanceof ConversationUnavailable && error.message === "transcript_missing" && live()) return readAgy();
      throw error;
    });
  } catch (error) {
    const refused = (error instanceof ConversationReadPending && !(error instanceof RevisionUnchecked)) || (error instanceof ConversationUnavailable && error.message === "transcript_missing");
    const paged = page.before !== undefined || page.since !== undefined || page.from !== undefined;
    if (resolved.source === "agy-transcript" && refused) {
      if (page.history_id === undefined && !paged) throw error;
      const catalog = agyDatabasePath(resolved.path);
      let bytes = 0;
      let writing = false;
      for (const file of [catalog, `${catalog}-wal`]) {
        try {
          const stat = statSync(file, { throwIfNoEntry: false });
          if (stat === undefined) continue;
          bytes += stat.size;
          const age = Date.now() - stat.mtimeMs;
          writing ||= age >= 0 && age < AGY_WRITE_RACE_MS;
        } catch {}
      }
      if (!writing || bytes > AGY_CATALOG_BYTES) throw error;
      const fresh = await sessionSnapshot().catch(() => null);
      const pane = fresh?.panes.find((candidate) => candidate.pane_id === paneId);
      if (!live() || pane === undefined) throw new ConversationUnavailable("no_session_id");
      if (!sameAgyStore(resolved.agy!, await resolveAgyStore(pane))) {
        throw paged ? new HistoryChanged() : new ConversationUnavailable("no_session_path");
      }
      let stat: Stats | undefined;
      try { stat = statSync(resolved.path, { throwIfNoEntry: false }); } catch {}
      if (!stat?.isFile()) throw paged ? new HistoryChanged() : error;
      const agyPrefix = `${stat.dev.toString(36)}-${stat.ino.toString(36)}-agy-`;
      if ([page.before, page.since, page.from].some((cursor) => cursor !== undefined && !cursor.startsWith(agyPrefix))) {
        throw new HistoryChanged();
      }
      if (page.history_id !== undefined && !page.history_id.startsWith(agyPrefix)
        && page.history_id !== `unwritten:${resolved.agy!.session}`
        && !page.history_id.startsWith(`unwritten:agy:${paneId}:${resolved.agy!.pid}:${resolved.agy!.started}`)) {
        throw new HistoryChanged();
      }
      throw new ConversationReadPending();
    }
    if (resolved.source !== "copilot-transcript" || !refused) throw error;
    // refused before its read (readSettled: the path names another file than the one authorized, as
    // after a replacement by rename): the history is the one the path names now, as a read beginning
    // now would bind it, and a cursor from another one has changed history
    if (prefix === null) {
      try { history = copilotHistoryIdentity(resolved.path); } catch { throw error; }
      prefix = copilotPrefix(paneId, `${resolved.binding}\0${history}`, resolved.path);
      copilotPage(page, prefix);
    }
    // Unpaged refreshes otherwise carry no proof of which history is on screen: older
    // clients without it keep their fail-closed fallback, with no recheck to wait on.
    if (page.history_id === undefined && !paged) throw error;
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
  // settling awaited after the transcript was resolved: a pane bound to another one since (a new session,
  // another agent) has not this answer. A pane seen bound elsewhere meanwhile is refused at once; any
  // other is resolved again (one more resolution per read), since nothing in Ovis may have looked at it,
  // and that resolution's own failure or not-begun session is the answer.
  if (transcript.source !== "copilot-transcript") {
    if (!live() || rebound(paneId, transcript)) throw new ConversationUnavailable("no_session_id");
    let fresh: NativeTranscript;
    try { fresh = await paneTranscript(paneId, codexHome, undefined, devinDbPath, opencodeDb, hermesHome, grokHome, museData); }
    catch (error) {
      if (error instanceof ConversationNotStarted) return await onNotStarted(error);
      throw error;
    }
    if (fresh.source !== transcript.source || fresh.path !== transcript.path || !live()) throw new ConversationUnavailable("no_session_id");
  }
  const identity = resolved.source === "agy-transcript" || resolved.source === "copilot-transcript" || resolved.source === "letta-transcript" || resolved.source === "kimi-transcript" ? resolved.path
    : resolved.source === "claude-transcript" ? nodePath.basename(resolved.path, ".jsonl")
    : resolved.source === "pi-transcript" || resolved.source === "cmd-transcript" || resolved.source === "omp-transcript" ? realpathSync(resolved.path) : null;
  const status = snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
  if (resolved.source === "grok-transcript" && answer.turns.length === 0 && page.before === undefined
    && (status === "working" || status === "blocked")) {
    let revision: string | null = null;
    try { revision = grokProjection(resolved.path, statSync(resolved.path)).revision; } catch {}
    if (revision === null || revision === "0") throw new ConversationUnavailable("transcript_missing");
  }
  // The ledger records the model only with the next message. The live status row names it at once,
  // and a switch there writes no turn, so the answer is marked screen and the chat re-reads it on
  // terminal output. A scroll or a failed read keeps the ledger's model rather than one from an
  // older frame, and is still marked screen so the next draw can fill it. The row is read before
  // the store check below, so a pane that moved to another conversation during the read is
  // refused, not given its model.
  const agyScreen = resolved.source === "agy-transcript" ? await screenMetadata("agy-transcript") : null;
  if (resolved.agy && !sameAgyStore(resolved.agy, await resolveAgyStore(snapshot.panes.find((pane) => pane.pane_id === paneId)!))) throw new ConversationUnavailable("no_session_path");
  // The screen read waits on herdr. A pane closed or bound to another session meanwhile has not
  // this conversation, nor the model its screen shows now, and nothing is recorded for it.
  if (agyScreen !== null && (!live() || rebound(paneId, transcript))) throw new ConversationUnavailable("no_session_id");
  if (identity !== null) { writtenSessions.add(`${resolved.source}\0${identity}`); rememberPaneSession(paneId, `${resolved.source}\0${identity}`); }
  // a Claude Ovis started tells its permission mode with each hook, also between the prompts its transcript records it
  // with: only for the session this transcript is (another one, resumed or cleared to, has its own)
  if (resolved.source === "claude-transcript" && identity !== null) answer = withToldMode(answer, toldMode(paneId), identity);
  if (resolved.source === "claude-transcript" && identity !== null && answer.metadata.context) {
    const window = readStatuslineContext(userHome(), identity, answer.metadata.model, resolved.path);
    if (window !== null) return {
      ...answer,
      metadata: { ...answer.metadata, context: { ...answer.metadata.context, window } },
      version: answerVersion(answer.version, String(window)),
    };
  }
  if (resolved.source === "codex-transcript") {
    // Codex writes the model it was asked for; a turn it moved to another model is said only by its server
    const served = servedStatus(paneId);
    if (served?.model && rolloutThread(resolved.path) === served.threadId.toLowerCase() && served.model !== answer.metadata.model) return {
      ...answer,
      metadata: { ...answer.metadata, model: served.model },
      version: answerVersion(answer.version, served.model),
    };
  }
  if (resolved.source === "cmd-transcript") {
    const herdrAgent = snapshot.agents.find((agent) => agent.pane_id === paneId);
    const model = typeof herdrAgent?.tokens?.model === "string" ? herdrAgent.tokens.model : null;
    if (model) return {
      ...answer,
      metadata: { ...answer.metadata, model },
      version: answerVersion(answer.version, model),
    };
  }
  if (resolved.source === "letta-transcript" && resolved.letta) {
    // Letta's transcript names no model, and /model writes no turn: its local store holds the
    // setting (lettaLocalSettings).
    const { store, agent, conversation } = resolved.letta;
    const settings = lettaLocalSettings(store, agent, conversation);
    if (settings !== null && (settings.model !== null || settings.reasoning_effort !== null)) return {
      ...answer,
      metadata: { ...answer.metadata, ...settings },
      version: answerVersion(answer.version, `${settings.model}\0${settings.reasoning_effort}`),
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
  if (agyScreen !== null) {
    // Enrich the response, never the shared page.
    // Live screen wins when readable (e.g. a /model switch before the next turn);
    // otherwise keep the transcript's recorded model/effort (e.g. herdr-core or a scrolled pane).
    const model = agyScreen.model ?? answer.metadata.model;
    const reasoning_effort = agyScreen.model !== null
      ? agyScreen.reasoning_effort
      : (agyScreen.reasoning_effort ?? answer.metadata.reasoning_effort);
    return {
      ...answer,
      screen: true,
      metadata: { ...answer.metadata, model, reasoning_effort },
      version: answerVersion(answer.version, `${model}\0${reasoning_effort}`),
    };
  }
  return answer;
}

interface CommandTranscript {
  readonly identity: string;
  readonly records: readonly CommandTranscriptRecord[];
}
const WINDOW_CHUNK_BYTES = 64 * 1024;
const windowStart = (size: number): number => size <= TRANSCRIPT_WINDOW_BYTES ? 0
  : Math.ceil((size - TRANSCRIPT_WINDOW_BYTES) / WINDOW_CHUNK_BYTES) * WINDOW_CHUNK_BYTES;
function chunkDigests(bytes: Buffer): BigUint64Array {
  const digests = new BigUint64Array(Math.ceil(bytes.length / WINDOW_CHUNK_BYTES));
  for (let index = 0; index < digests.length; index++) {
    digests[index] = BigInt(Bun.hash.xxHash3(bytes.subarray(index * WINDOW_CHUNK_BYTES, (index + 1) * WINDOW_CHUNK_BYTES)));
  }
  return digests;
}
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
  branch: string; leaf: string | null; answer: CommandTranscript | null;
  branches: Map<string, { id: string; offset: number }>;
}>();
const REMEMBERED_BRANCHES = 8;

export async function readCommandTranscript(paneId: string, codexHome?: string, look: { snapshot?: SessionSnapshot; processes?: KnownProcesses } = {}): Promise<CommandTranscript | null> {
  const resolved = await paneTranscript(paneId, codexHome, look.snapshot, undefined, undefined, undefined, undefined, undefined, look.processes);
  const { source, path } = resolved;
  if (source !== "claude-transcript" && source !== "codex-transcript" && source !== "pi-transcript"
    && source !== "omp-transcript" && source !== "omo-transcript" && source !== "gjc-transcript") return null;
  // one exact stat: a file the resolver itself authorized (omp, pi, gjc, omo) is the only one read, compared whole as
  // Windows' file indexes need; omp's answer for a file it could not authorize names none, and is not read.
  // The read below is held to this stat's exact file (#3398)
  const exact = statSync(path, { bigint: true });
  const authorized = resolved.source === "omp-transcript" ? resolved.ompFile : resolved.source === "pi-transcript" ? resolved.piFile
    : resolved.source === "gjc-transcript" ? resolved.gjcFile : resolved.source === "omo-transcript" ? resolved.omoFile
    : resolved.source === "claude-transcript" ? resolved.claudeFile
    : resolved.source === "codex-transcript" ? resolved.codexFile : undefined;
  if ((authorized !== undefined || source === "omp-transcript") && authorized !== `${exact.dev}:${exact.ino}`) return null;
  const stat = { dev: exact.dev, ino: exact.ino, size: Number(exact.size), mtimeMs: Number(exact.mtimeNs) / 1e6 };
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
  // read through the file the stat above named: another one swapped in for this open is no outcome (#3398)
  try {
    const read = readBound([[path, stat]], () => {
      const fd = openBound(path);
      try { return readSync(fd, bytes, 0, bytes.length, start); } finally { closeSync(fd); }
    });
    if (read !== bytes.length) return null;
  } catch (error) { if (error instanceof ConversationReadPending) return null; throw error; }
  let from = start;
  if (start > 0) {
    const newline = bytes.indexOf(0x0a);
    from += newline < 0 ? bytes.length : newline + 1;
  }
  const digests = chunkDigests(bytes);
  const append = cached?.file === file && stat.size > cached.end && start < cached.end
    && cached.partialStart >= from && sameOverlap(cached, start, bytes, digests);
  const readFrom = append ? cached.partialStart : from;
  const partialStart = Math.max(from, start + bytes.lastIndexOf(0x0a) + 1);
  const records = [
    ...(append ? cached.records.filter(record => record.offset >= from) : []),
    ...commandTranscriptRecords(bytes.subarray(readFrom - start, partialStart - start).toString("utf8"), readFrom),
  ];
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
      if (!parent && typeof parentId === "string" && start > 0) { rooted = true; break; }
      if (!parent || parent.record.offset >= record.offset) break;
      node = parent;
    }
    current = rooted ? active.reverse() : [];
    leaf = rooted && current.length > 0 ? String(current.at(-1)!.entry.id) : null;
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

function runsOnFromCut(leaf: string, path: readonly CommandTranscriptRecord[], forks: readonly CommandTranscriptRecord[], first: CommandTranscriptRecord | undefined): boolean {
  const head = path[0];
  return head !== undefined && head === first && head.entry.parentId === leaf && forks.every((fork) => fork === head);
}

export function transcriptPage(source: Exclude<StreamSource, "agy-transcript">, path: string, page: ConversationPage = {}, codexHome?: string, piAgentDir?: string | null): RecognizedConversation {
  // the files the page opens are held to the ones it began with (transcriptPageRead binds them)
  return readBound([], () => {
    if (source === "copilot-transcript") {
      let fd: number;
      try { fd = openCopilotFile(path); }
      catch (error) {
        if (error instanceof ConversationReadPending) throw error;
        throw new ConversationUnavailable("transcript_missing");
      }
      try { return transcriptPageRead(source, path, page, codexHome, undefined, fd, piAgentDir); }
      finally { closeSync(fd); }
    }
    return transcriptPageRead(source, path, page, codexHome, undefined, undefined, piAgentDir);
  });
}

export async function agyTranscriptPage(path: string, page: ConversationPage = {}, codexHome?: string, authorized?: { dev: number; ino: number }): Promise<RecognizedConversation> {
  try {
    return await withAgyHistory(path, (projection, fd) => {
      const read = transcriptPageRead("agy-transcript", path, page, codexHome, projection, fd);
      const model = projection.model ?? read.metadata.model;
      const reasoning_effort = projection.model !== null ? projection.reasoning_effort : (projection.reasoning_effort ?? read.metadata.reasoning_effort);
      const metadata = { ...read.metadata, model, reasoning_effort };
      return {
        ...read,
        metadata,
        activity: projection.activity,
        version: model !== read.metadata.model || reasoning_effort !== read.metadata.reasoning_effort
          ? answerVersion(read.version, `${model}\0${reasoning_effort}`)
          : read.version,
      };
    }, authorized);
  }
  catch (error) {
    // every file thread busy: worth another try soon (http.ts answers 503); another file than the
    // authorized one is pending (withAgyHistory)
    if (error instanceof HistoryChanged || error instanceof ConversationUnavailable || error instanceof FileBusyError || error instanceof ConversationReadPending) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }
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
  // every other open of it in this page is held to this file, unless the caller bound it already
  bindFile(path, stat);
  let stream: TranscriptStream;
  try {
    stream = transcriptStream(source, path, stat, codexHome ?? defaultCodexHome(), agy, fd);
    applyHistoryBoundary(path, stream, source);
  } catch (error) {
    if (error instanceof ConversationUnavailable || error instanceof ConversationReadPending) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }
  const key = page.before !== undefined
    ? `${path}\0${source}\0before:${page.before}:${page.since ?? ""}:${pagePrompts(page)}`
    : `${path}\0${source}\0from:${page.from ?? ""}:${pagePrompts(page)}`;
  const catalogs = piAgentDir === undefined ? "" : `:${piAgentDir}`;
  const signature = page.before !== undefined ? `${stream.id}${catalogs}` : `${stream.id}:${stream.length}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}${catalogs}`;
  const cached = cache.get(key);
  const version = answerVersion(key, signature);
  const size = page.before === undefined ? { transcript_bytes: stat.size } : {};
  if (cached?.signature === signature) {
    return { source, turns: cached.turns, metadata: cached.metadata, cursor: cached.cursor, abandoned: cached.abandoned, history_id: stream.id, version, ...size };
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
      if (newest !== null) {
        if (source === "copilot-transcript") forgetCopilotTurns(path);
        start = held !== null && held >= newest.start ? held : newest.start;
        live = liveTurns(path, stream, source, start, newest.starts, piAgentDir);
        text = "";
      } else {
        if (source === "copilot-transcript") {
          const turn = copilotNewestTurn(path, stream, pagePrompts(page));
          start = held !== null && held >= turn.start ? held : turn.start;
          text = turn.lines.filter(({ at }) => at >= start).map(({ line }) => `${line}\n`).join("") + turn.partial;
        } else {
          const whole = pageBefore(stream, source, stream.length, { widen: false, prompts: pagePrompts(page) });
          start = held !== null && held >= whole.start ? held : whole.start;
          text = whole.bytes.subarray(start - whole.start).toString("utf8");
        }
      }
    }
    if (live === null && page.before === undefined && start > stream.floor) head = metadataHead(path, stream, source, start);
    cursor = formatCursor(stream, start);
  } catch (error) {
    if (error instanceof HistoryChanged || error instanceof ConversationUnavailable || error instanceof ConversationReadPending) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }

  const parsed = live?.turns ?? parseTurns(source, path, text, undefined, undefined, start, source === "omo-transcript" ? omoAsksBefore(path, stream, start) : undefined);
  const turns = parsed.some((turn, index) => turn.parts[0]?.kind === "goal_wait" && (page.before !== undefined || index < parsed.length - 1))
    ? parsed.filter((turn, index) => turn.parts[0]?.kind !== "goal_wait" || (page.before === undefined && index === parsed.length - 1))
    : parsed;
  const metadata = live?.metadata ?? parseConversationMetadata(`${head}\n${text}`, source, undefined, piAgentDir);
  // Record the stat from BEFORE the read: an append during parsing must cause
  // another read on the next poll, not permanently cache a torn tail.
  cache.delete(key);
  const abandoned = (source === "pi-transcript" || source === "cmd-transcript") ? piAbandonedTurns(path, stat.size) ?? undefined : undefined;
  rememberPage(cache, key, { source, signature, turns, metadata, cursor, abandoned }, 32);
  return { source, turns, metadata, cursor, abandoned, history_id: stream.id, version, ...size };
}

export async function conversationImage(paneId: string, ref: string, codexHome?: string, opencodeDb?: string, grokHome?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const child = coreAcp()?.forPane(paneId);
  if (child) {
    const asset = await child.client.history.asset(ref);
    return typeof asset === "string" ? null : asset;
  }
  if (!CLAUDE_IMAGE_REF.test(ref) && !CODEX_IMAGE_REF.test(ref) && !CODEX_TOOL_IMAGE_REF.test(ref) && !PI_IMAGE_REF.test(ref) && !PI_PROMPT_IMAGE_REF.test(ref) && !OPENCODE_IMAGE_REF.test(ref) && !GROK_IMAGE_REF.test(ref) && !COPILOT_IMAGE_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: ResolvedTranscript;
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes, opencodeDb, undefined, grokHome); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  if (resolved.source === "opencode-transcript") return opencodeImage(resolved.path, resolved.session, ref);
  rememberPaneRead(paneId, resolved.path);
  if (resolved.source === "codex-transcript") {
    if (CODEX_TOOL_IMAGE_REF.test(ref)) return codexToolImage(resolved.path, ref, resolved.codexHome ?? codexHome ?? defaultCodexHome());
    return codexPromptImage(resolved.path, ref, pane.cwd, resolved.codexHome ?? codexHome);
  }
  if (resolved.source === "pi-transcript" || resolved.source === "cmd-transcript") return readAuthorized(resolved.path, () => piTranscriptImage(resolved.path, ref));
  if (resolved.source === "omo-transcript") {
    const [dev, ino] = resolved.omoFile === undefined ? [] : resolved.omoFile.split(":").map(BigInt);
    return ompTranscriptImage(resolved.path, ref, null, "omo-transcript", dev === undefined || ino === undefined ? undefined : { dev, ino });
  }
  if (resolved.source === "grok-transcript") return grokImage(resolved.path, ref);
  if (resolved.source === "copilot-transcript") return copilotImage(resolved.path, ref);
  // the store is held to the identity it had where the transcript was authorized (ompAuthorizedTranscript):
  // a path above it swapped since cannot move the read elsewhere
  if (resolved.source === "omp-transcript") return ompTranscriptImage(resolved.path, ref, resolved.ompBlobs ?? null);
  return resolved.source === "claude-transcript" ? transcriptImageAsync(resolved.path, ref) : null;
}

/**
 * A picture a Codex prompt holds (codexTranscriptImage), over the history the live rollout names as the
 * lookup begins: its chain is discovered with that rollout bound (another file at its path, swapped in around
 * an open, names no parent), and every rollout is then read as the file it was then.
 */
export async function codexPromptImage(path: string, ref: string, cwd: string, codexHome?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const authorized = authorizedFile(path);
  if (authorized === null) return null;
  let segments: HistorySegment[];
  try { segments = readBound([[path, authorized]], () => codexHistorySegments(path, codexHome)); } catch { return null; }
  return codexTranscriptImage(segments.map((segment) => segment.path === path ? { ...segment, identity: authorized } : segment), ref, cwd);
}

const IMAGE_SEARCH_WINDOW = 1024 * 1024;
const CALL_SEARCH_START = 64 * 1024;

const JSON_SHORT_ESCAPES: Readonly<Record<string, string>> = { '"': '\\"', "\\": "\\\\", "/": "\\/", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function jsonTextPattern(text: string): { pattern: RegExp; span: number } {
  return finish(jsonTextPatternSteps(text));
}

function* jsonTextPatternSteps(text: string): Steps<{ pattern: RegExp; span: number }> {
  const literal = (bytes: string) => bytes.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
  let source = "";
  let span = 0;
  let characters = 0;
  for (const char of text) {
    if (++characters % 1024 === 0) yield;
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

function* linesWithSteps(stream: TranscriptStream, text: string, from: number, to: number, head?: Buffer): Steps<[number, number][]> {
  const { pattern, span } = yield* jsonTextPatternSteps(text);
  const found: [number, number][] = [];
  let start = from;
  let hit = false;
  let tail = "";
  let judged = 0;
  for (let position = from, step = 0; position < to; position = Math.min(to, position + step)) {
    const known = position === from && head !== undefined && head.length > 0 ? head.subarray(0, to - from) : undefined;
    step = known?.length ?? IMAGE_SEARCH_WINDOW;
    const bytes = (known ?? (yield* streamBytes(stream, position, Math.min(to, position + IMAGE_SEARCH_WINDOW)))).toString("latin1");
    for (let offset = 0; ;) {
      const newline = bytes.indexOf("\n", offset);
      if (!hit) {
        const piece = bytes.slice(offset, newline === -1 ? bytes.length : newline);
        hit = pattern.test(piece) || (tail.length > 0 && pattern.test(tail + piece.slice(0, span)));
        tail = span <= 1 ? "" : piece.length >= span - 1 ? piece.slice(-(span - 1)) : (tail + piece).slice(-(span - 1));
      }
      if (newline === -1) break;
      if (hit) found.push([start, position + newline]);
      start = position + newline + 1;
      hit = false;
      tail = "";
      offset = newline + 1;
      if (++judged % RECORDS_PER_STEP === 0) yield;
    }
    if (known === undefined && position + step < to) yield;
  }
  if (hit) found.push([start, to]);
  return found;
}

const SHAPE_STRING_BYTES = 1024;
/** The most of one record's shape the endpoint holds: past it the record is not judged, and nothing it could decide is served. */
const SHAPE_MAX_BYTES = 4 * 1024 * 1024;
const PICTURE_TEXT_BYTES = Math.floor((MAX_IMAGE_BYTES + 3) * 4 / 3);

interface RecordShape { entry: TranscriptEntry; cut: [number, number][]; mark: string }
const NOT_A_RECORD = "not a record";
const UNREAD = "unread";
type ShapeRead = RecordShape | typeof NOT_A_RECORD | typeof UNREAD;

/**
 * One transcript record, parsed as the page parses it but read a window at a time: every string past
 * SHAPE_STRING_BYTES is cut there (its rest checked as JSON.parse would check it) and ends in a mark
 * no record can hold, a nonce made for this read, and its place in `cut` (`wholeString` reads it
 * back).
 */
function* recordShapeSteps(stream: TranscriptStream, [start, end]: [number, number]): Steps<ShapeRead> {
  const nonce = randomUUID();
  const kept: Buffer[] = [];
  let size = 0;
  const cut: [number, number][] = [];
  let inString = false;
  let escape = 0;
  let length = 0;
  let cutting = false;
  let stringStart = 0;
  const keep = (bytes: Buffer) => { kept.push(Buffer.from(bytes)); size += bytes.length; };
  for (let position = start; position < end; position += IMAGE_SEARCH_WINDOW) {
    const bytes = yield* streamBytes(stream, position, Math.min(end, position + IMAGE_SEARCH_WINDOW));
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

const JSON_ESCAPE_LETTERS = new Set([...'"\\/bfnrtu'].map((letter) => letter.charCodeAt(0)));
function isHexDigit(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

function* wholeStringSteps(stream: TranscriptStream, shape: RecordShape, value: string, limit: number): Steps<string | null> {
  let whole = "";
  return (yield* scanStringSteps(stream, shape, value, limit, (piece) => { whole += piece; })) ? whole : null;
}

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
    const text = pending + (last ? decoder.decode(yield* streamBytes(stream, position, range[1])) : decoder.decode(yield* streamBytes(stream, position, position + IMAGE_SEARCH_WINDOW), { stream: true }));
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

function* callIdSteps(stream: TranscriptStream, shape: RecordShape, id: unknown): Steps<string | null> {
  return typeof id === "string" ? yield* wholeStringSteps(stream, shape, id, PICTURE_TEXT_BYTES) : String(id ?? "");
}

/**
 * Whether a tool result before `before` would be drawn, as the parser decides it: it answers a call
 * an assistant entry the parser draws made, and no result before it answered that call already.
 * False too when a record it would have to judge (one after that last block) is past
 * what the endpoint reads: then it serves nothing rather than guess.
 */
function* answersDrawnCallSteps(stream: TranscriptStream, id: string, before: number): Steps<boolean> {
  // a record before the result the endpoint may not judge refuses the forward search wherever it lies, the
  // last block naming the call or not: the search does not go back past such a record, it goes forward
  const index = pictureIndexOn ? stream.pictures : undefined;
  if (index === undefined || (index.blind !== null && index.blind < before) || unreadBefore(stream, index, before)) return yield* answersDrawnCallForwardSteps(stream, id, before);
  const numeric = id !== "" && String(Number(id)) === id;
  let judged = 0;
  let span = CALL_SEARCH_START;
  let scratch = Buffer.allocUnsafe(stream.file === undefined ? CALL_SEARCH_START : 0);
  for (let to = before, from = before; to > stream.floor; span = Math.min(IMAGE_SEARCH_WINDOW, Math.max(span, to - from) * 2), to = from, yield) {
    from = Math.max(stream.floor, to - span);
    let head: Buffer | undefined;
    // each piece back twice the one before, up to a window: a line of a MiB costs a few reads, not
    // sixteen, where every read is a round trip (a network home)
    for (let piece = CALL_SEARCH_START; from > stream.floor; piece = Math.min(IMAGE_SEARCH_WINDOW, piece * 2)) {
      const low = Math.max(stream.floor, from - piece);
      let bytes: Buffer;
      if (stream.file === undefined) {
        if (scratch.length < from - low) scratch = Buffer.allocUnsafe(Math.min(IMAGE_SEARCH_WINDOW, Math.max(from - low, scratch.length * 2)));
        bytes = readStreamInto(stream, low, from, scratch);
      } else bytes = yield* streamBytes(stream, low, from);
      const newline = bytes.lastIndexOf(0x0a);
      if (newline !== -1) head = stream.file === undefined ? bytes.subarray(newline + 1) : Buffer.from(bytes.subarray(newline + 1));
      yield;
      if (newline !== -1) { from = low + newline + 1; break; }
      from = low;
    }
    const ranges = yield* linesWithSteps(stream, id, from, to, head);
    if (numeric) {
      yield;
      const seen = new Set(ranges.map(([start]) => start));
      for (const range of yield* linesWithSteps(stream, "tool_use", from, to, head)) if (!seen.has(range[0])) ranges.push(range);
      ranges.sort((left, right) => left[0] - right[0]);
    }
    if (ranges.length > 0) yield;
    for (const range of ranges.reverse()) {
      if (++judged % RECORDS_PER_STEP === 0) yield;
      const shape = yield* recordShapeSteps(stream, range);
      if (shape === UNREAD) return false;
      if (shape === NOT_A_RECORD) continue;
      const entry = shape.entry;
      if (entry.isMeta || entry.isCompactSummary || !Array.isArray(entry.message?.content)) continue;
      const content: unknown[] = entry.message.content;
      for (let at = content.length - 1; at >= 0; at -= 1) {
        if (++judged % RECORDS_PER_STEP === 0) yield;
        const part = content[at] as { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown } | null;
        const call = entry.type === "assistant" && part?.type === "tool_use" && typeof part.name === "string" ? yield* callIdSteps(stream, shape, part.id)
          : entry.type === "user" && part?.type === "tool_result" && typeof part.tool_use_id === "string" ? yield* callIdSteps(stream, shape, part.tool_use_id) : undefined;
        if (call === undefined) continue;
        if (call === null) return false;
        if (call === id) return part?.type === "tool_use";
      }
    }
  }
  return false;
}

function* answersDrawnCallForwardSteps(stream: TranscriptStream, id: string, before: number): Steps<boolean> {
  const ranges = yield* linesWithSteps(stream, id, stream.floor, before);
  if (id !== "" && String(Number(id)) === id) {
    const seen = new Set(ranges.map(([start]) => start));
    for (const range of yield* linesWithSteps(stream, "tool_use", stream.floor, before)) if (!seen.has(range[0])) ranges.push(range);
    ranges.sort((left, right) => left[0] - right[0]);
  }
  let open = false;
  let judged = 0;
  for (const range of ranges) {
    if (++judged % RECORDS_PER_STEP === 0) yield;
    const shape = yield* recordShapeSteps(stream, range);
    if (shape === UNREAD) return false;
    if (shape === NOT_A_RECORD) continue;
    const entry = shape.entry;
    if (entry.isMeta || entry.isCompactSummary || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (++judged % RECORDS_PER_STEP === 0) yield;
      const part = block as { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown } | null;
      const call = entry.type === "assistant" && part?.type === "tool_use" && typeof part.name === "string" ? yield* callIdSteps(stream, shape, part.id)
        : entry.type === "user" && part?.type === "tool_result" && typeof part.tool_use_id === "string" ? yield* callIdSteps(stream, shape, part.tool_use_id) : undefined;
      if (call === undefined) continue;
      if (call === null) return false;
      if (call === id) open = part?.type === "tool_use";
    }
  }
  return open;
}

/**
 * It is read as the page is: after the last /clear, on the branch a rewind left the session on, and a
 * tool's picture only from a result the page draws.
 */
type TranscriptPicture = { mediaType: string; bytes: Uint8Array<ArrayBuffer> };

export function transcriptImage(path: string, ref: string): TranscriptPicture | null {
  try { return finish(transcriptImageSteps(path, ref, false)); } catch { return null; }
}

export async function transcriptImageAsync(path: string, ref: string): Promise<TranscriptPicture | null> {
  const began = { began: performance.now(), wall: Date.now() };
  // the file the lease pins is the one the path names as the lookup begins, not one put there while it waited its turn
  const authorized = authorizedFile(path);
  if (authorized === null) return null;
  try { return await imageTurn(path, () => transcriptReader.read(path, (file) => finishAsync(boundSteps([[path, authorized]], transcriptImageSteps(path, ref, true, file, began))), { follow: true })); } catch { return null; }
}

const imageTurns = new Map<string, Promise<void>>();
function imageTurn<T>(path: string, read: () => Promise<T>): Promise<T> {
  const turn = (imageTurns.get(path) ?? Promise.resolve()).then(read);
  const done = turn.then(() => {}, () => {});
  imageTurns.set(path, done);
  void done.then(() => { if (imageTurns.get(path) === done) imageTurns.delete(path); });
  return turn;
}

function sameImageFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function* transcriptImageSteps(path: string, ref: string, apart: boolean, file?: TranscriptFile, began?: { began: number; wall: number }): Steps<TranscriptPicture | null> {
  const match = CLAUDE_IMAGE_REF.exec(ref);
  if (match === null) return null;
  const fd = file === undefined ? openSync(path, "r") : undefined;
  const pinned = function* (): Steps<Stats> { return file === undefined ? fstatSync(fd!) : yield* awaited(file.stats()); };
  // the path still names the file as `snapshot` saw it, its change time included: a same-size rewrite
  // can put the modification time back
  const named = function* (snapshot: Stats): Steps<boolean> {
    return sameImageFile(snapshot, file === undefined ? statSync(path) : yield* awaited(file.pathStats()));
  };
  const boundary = clearScans.get(path);
  const boundaryScanned = boundary?.scanned;
  const scans: TranscriptStream[] = [];
  const unpublish = (...streams: TranscriptStream[]): null => {
    const kept = clearScans.get(path);
    if (kept !== undefined && (streams.some((scanned) => scanned.published?.scan === kept && scanned.published.through === kept.scanned) || (kept === boundary && boundary.scanned === boundaryScanned))) clearScans.delete(path);
    return null;
  };
  try {
    const stat = yield* pinned();
    checkBoundFile(path, stat);
    const current = function* (snapshot: Stats): Steps<boolean> { return sameImageFile(snapshot, yield* pinned()) && (yield* named(snapshot)); };
    if (file === undefined && !(yield* current(stat))) return null;
    const stream = transcriptStream("claude-transcript", path, stat, defaultCodexHome(), undefined, fd, file !== undefined);
    stream.file = file;
    if (began !== undefined && stream.version !== undefined) stream.version = { ...stream.version, ...began };
    scans.push(stream);
    stream.current = () => current(stat);
    if (apart) stream.seen = { from: 0, digest: 0n };
    yield* applyHistoryBoundarySteps(path, stream, "claude-transcript", apart);
    const picture = yield* claudePictureSteps(stream, match, apart);
    if (!apart || (yield* current(stat))) return picture;
    if (picture === null) return unpublish(stream);
    // It changed under the read: only an append can keep the picture, and what was read may since be gone
    // (a rewrite, then its undoing: ABA).
    const now = yield* pinned();
    if (now.dev !== stat.dev || now.ino !== stat.ino || now.size <= stat.size || !(yield* named(now))) return unpublish(stream);
    const seen = stream.seen!;
    let digest = 0n;
    for (let position = seen.from; position < stat.size; position = Math.min(stat.size, position + TRANSCRIPT_WINDOW_BYTES)) {
      digest = Bun.hash.xxHash3(yield* streamBytes({ ...stream, hidden: undefined }, position, Math.min(stat.size, position + TRANSCRIPT_WINDOW_BYTES)), digest);
      yield;
    }
    if (digest !== seen.digest) return unpublish(stream);
    const active = transcriptStream("claude-transcript", path, now, defaultCodexHome(), undefined, fd, file !== undefined);
    active.file = file;
    scans.push(active);
    active.current = () => current(now);
    yield* applyHistoryBoundarySteps(path, active, "claude-transcript", true, true);
    const again = yield* claudePictureSteps(active, match, true);
    return again !== null && (yield* current(now)) ? again : unpublish(stream, active);
  } catch { return unpublish(...scans); }
  finally { if (fd !== undefined) closeSync(fd); }
}

let pictureIndexOn = true;
export function pictureIndexForTests(on: boolean): void {
  pictureIndexOn = on;
}

function unreadBefore(stream: TranscriptStream, index: PictureIndex, before: number): boolean {
  return index.unread.some(([start, end]) => start >= stream.floor && start < before && !stream.hidden?.some(([low, high]) => low <= end && start < high));
}

function indexedPicture(stream: TranscriptStream, uuid: string): IndexedPicture | undefined {
  const index = pictureIndexOn ? stream.pictures : undefined;
  const record = index?.at.get(uuid);
  if (record === undefined || record.start < stream.floor || record.end >= stream.length) return undefined;
  if (stream.hidden?.some(([start, end]) => start <= record.end && record.start < end)) return undefined;
  return unreadBefore(stream, index!, record.start) ? undefined : record;
}

function forgetPictures(index: PictureIndex): void {
  index.at.clear();
  index.blind = 0;
}

const NOT_IT = "not it";

/**
 * A same-size rewrite within one filesystem timestamp tick keeps the version: a read of the bytes
 * vouches for a version to any lookup that began before it, and to a later one only when it began at
 * least this long after the version's mtime and ctime (claude-command-history's RACY_MS) and those
 * times tick finer than that (fineTimes).
 */
const PICTURE_RACY_MS = 3000;
/**
 * Whether the version's ctime, which every write sets and no writer can, has a fraction of a second: then
 * the filesystem's timestamps tick finer than PICTURE_RACY_MS, and a write made well after them moves it.
 * A source of whole seconds (or of times held for a while, as a coarse or cached one reports them) can
 * keep a version's times across such a rewrite, so no read vouches for that version to a later lookup.
 * A fine ctime that falls on a whole second only costs a read.
 */
const fineTimes = (version: NonNullable<TranscriptStream["version"]>): boolean => version.ctimeMs % 1000 !== 0;
interface PictureCheck extends PictureRead { bytes: PictureBytes; stands?: boolean }
const pictureChecks = new Map<string, PictureCheck>();
const vouches = (read: PictureRead, version: NonNullable<TranscriptStream["version"]>): boolean => read.began >= version.began
  || (fineTimes(version) && Date.now() >= read.wall && read.wall - version.mtimeMs >= PICTURE_RACY_MS && read.wall - version.ctimeMs >= PICTURE_RACY_MS);
const vouchedFor = (index: PictureIndex, version: TranscriptStream["version"]): boolean =>
  version !== undefined && index.vouched?.key === version.key && vouches(index.vouched, version);
const sameBytes = (left: PictureBytes, right: PictureBytes): boolean => left.from === right.from && left.hashed === right.hashed
  && left.digest === right.digest && left.through === right.through && Buffer.from(left.pending).equals(right.pending);

/**
 * Trusts the stream's picture index only while the bytes it was built from are still what the file
 * holds. A scan kept from before a rewrite in place that grew the file is checked only by the bytes just
 * before where it ended, so a line before the record it indexed may since have become another record of
 * that uuid, or one the endpoint cannot judge: the search would decide otherwise.
 */
function* vouchedPictureSteps(stream: TranscriptStream, apart: boolean): Steps<void> {
  const index = pictureIndexOn ? stream.pictures : undefined;
  const version = stream.version;
  if (index === undefined || (index.blind !== null && index.blind <= index.bytes.from)) return;
  if (version === undefined) return forgetPictures(index);
  if (vouchedFor(index, version)) return;
  let check = pictureChecks.get(version.key);
  if (check === undefined || !sameBytes(check.bytes, index.bytes) || check.began < version.began || (check.stands === undefined && !apart)) {
    check = { bytes: { ...index.bytes }, began: performance.now(), wall: Date.now() };
    if (apart) remember(pictureChecks, version.key, check, 32);
    try { check.stands = yield* pictureBytesStandSteps(stream, index.bytes); }
    finally { check.stands ??= false; }
  }
  while (check.stands === undefined) yield;
  if (check.stands) index.vouched = { key: version.key, began: check.began, wall: check.wall };
  else forgetPictures(index);
}

function* pictureBytesStandSteps(stream: TranscriptStream, bytes: PictureBytes): Steps<boolean> {
  if (bytes.through > stream.length) return false;
  const raw = { ...stream, hidden: undefined };
  let digest = 0n;
  for (let at = bytes.from; at < bytes.hashed;) {
    const end = Math.min(bytes.hashed, (Math.floor(at / IMAGE_SEARCH_WINDOW) + 1) * IMAGE_SEARCH_WINDOW);
    const read = yield* streamBytes(raw, at, end);
    if (read.length !== end - at) return false;
    for (let piece = at; piece < end; piece = Math.min(end, pieceEnd(piece))) digest = Bun.hash.xxHash3(read.subarray(piece - at, Math.min(end, pieceEnd(piece)) - at), digest);
    at = end;
    yield;
  }
  return digest === bytes.digest && (yield* streamBytes(raw, bytes.hashed, bytes.through)).equals(bytes.pending);
}

function* claudePictureSteps(stream: TranscriptStream, match: RegExpExecArray, apart: boolean): Steps<TranscriptPicture | null> {
  yield;
  const uuid = match[1]!;
  const index = pictureIndexOn ? stream.pictures : undefined;
  if (index !== undefined && indexedPicture(stream, uuid) === undefined && !vouchedFor(index, stream.version)) stream = { ...stream, pictures: undefined };
  else yield* vouchedPictureSteps(stream, apart);
  const indexed = indexedPicture(stream, uuid);
  if (indexed !== undefined) {
    const found = yield* pictureInRecordSteps(stream, match, [indexed.start, indexed.end]);
    if (found !== NOT_IT) return found;
    forgetPictures(stream.pictures!);
    yield;
  }
  let judged = 0;
  for (const range of yield* linesWithSteps(stream, uuid, stream.floor, stream.length)) {
    if (++judged % RECORDS_PER_STEP === 0) yield;
    const found = yield* pictureInRecordSteps(stream, match, range);
    if (found !== NOT_IT) return found;
  }
  return null;
}

function* pictureInRecordSteps(stream: TranscriptStream, [, uuid, index, nested]: RegExpExecArray, range: [number, number]): Steps<TranscriptPicture | null | typeof NOT_IT> {
  let judged = 0;
  const shape = yield* recordShapeSteps(stream, range);
  // a record the endpoint cannot judge could be the one the page draws: serve nothing then
  if (shape === UNREAD) return null;
  if (shape === NOT_A_RECORD) return NOT_IT;
  const entry = shape.entry;
  if (entry.uuid !== uuid || entry.type !== "user" || entry.isMeta || entry.isCompactSummary || !Array.isArray(entry.message?.content)) return NOT_IT;
  const content: unknown[] = entry.message.content;
  const block = content[Number(index)] as { type?: unknown; content?: unknown; tool_use_id?: unknown } | undefined;
  let image: unknown = block;
  if (nested !== undefined) {
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string" || !Array.isArray(block.content)) return null;
    const call = yield* callIdSteps(stream, shape, block.tool_use_id);
    if (call === null) return null;
    for (let at = 0; at < Number(index); at += 1) {
      if (++judged % RECORDS_PER_STEP === 0) yield;
      const result = content[at] as { type?: unknown; tool_use_id?: unknown } | null;
      if (result?.type === "tool_result" && typeof result.tool_use_id === "string" && (yield* callIdSteps(stream, shape, result.tool_use_id)) === call) return null;
    }
    if (!(yield* answersDrawnCallSteps(stream, call, range[0]))) return null;
    image = block.content[Number(nested)];
  }
  const picture = image as { source?: { data?: unknown } } | null | undefined;
  const data = typeof picture?.source?.data === "string" ? yield* wholeStringSteps(stream, shape, picture.source.data, PICTURE_TEXT_BYTES) : null;
  if (data === null) return null;
  const mediaType = claudeImageType({ ...picture, source: { ...picture!.source, data } });
  if (mediaType === null) return null;
  return { mediaType, bytes: new Uint8Array(Buffer.from(data, "base64")) };
}

const TOOL_REF = /^[A-Za-z0-9_:.-]{1,128}$/;
const TOOL_OUTPUT_MAX = 2_000_000;

export async function toolOutput(paneId: string, ref: string, codexHome?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string): Promise<string | null> {
  const child = coreAcp()?.forPane(paneId);
  if (child) {
    const asset = await child.client.history.asset(ref);
    return typeof asset === "string" ? asset : null;
  }
  if (!TOOL_REF.test(ref) && !/^cp[0-9a-f]{16}\.[A-Za-z0-9_:.-]{1,128}(?:@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32})?$/.test(ref)) return null;
  const socket = herdrSocketPath();
  const forgetsBefore = forgets;
  const live = (): boolean => herdrSocketPath() === socket && !forgottenSince(paneId, forgetsBefore);
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: ResolvedTranscript;
  try { resolved = noteBinding(paneId, await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes, opencodeDb, hermesHome, grokHome, museData)); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  if (resolved.source === "opencode-transcript") {
    const output = opencodeToolOutput(resolved.path, resolved.session, ref);
    return output !== null && output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  rememberPaneRead(paneId, resolved.path);
  if (resolved.source === "dsh-transcript") return await dshToolOutput(resolved, ref);
  if (resolved.source === "kiro-transcript") return await kiroToolOutput(resolved, ref);
  if (resolved.source === "hermes-transcript") return hermesToolOutput(resolved.sessionId, resolved.path, ref, TOOL_OUTPUT_MAX);
  const transcript = resolved;
  const lookup = (): string | null => {
    let nativeRef = ref;
    if (transcript.source === "copilot-transcript") {
      let history: string;
      try { history = copilotHistoryIdentity(transcript.path); } catch { return null; }
      const prefix = copilotPrefix(paneId, `${transcript.binding}\0${history}`, transcript.path);
      if (!ref.startsWith(prefix)) return null;
      nativeRef = ref.slice(prefix.length);
      if (!nativeRef.includes("@")) return null;
    }
    return transcript.source === "agy-transcript" || transcript.source === "letta-transcript" ? null
      : transcriptToolOutput(transcript.source, transcript.path, nativeRef, transcript.codexHome ?? codexHome);
  };
  let output: string | null;
  if (resolved.source === "copilot-transcript" || resolved.source === "omo-transcript") {
    let settled: { value: string | null } | null;
    try { settled = await readSettled({ path: resolved.path, checkWindow: false, live }, lookup); }
    catch (error) { if (error instanceof ConversationUnavailable || error instanceof ConversationReadPending) return null; throw error; }
    // a pane bound to another transcript while this settled (another OmO session) has not this output:
    // one seen bound elsewhere is refused at once, any other resolved again.
    if (settled === null || rebound(paneId, transcript)) return null;
    if (transcript.source === "omo-transcript") {
      let fresh: NativeTranscript;
      try { fresh = await paneTranscript(paneId, codexHome, undefined, undefined, opencodeDb, hermesHome, grokHome, museData); }
      catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
      if (fresh.source !== transcript.source || fresh.path !== transcript.path || rebound(paneId, transcript)) return null;
    }
    output = settled.value;
  } else if (resolved.source === "pi-transcript" || resolved.source === "cmd-transcript" || resolved.source === "codex-transcript") {
    output = readAuthorized(resolved.path, lookup);
  } else if (resolved.source === "letta-transcript") {
    // scanned on a file thread, which reads only the file the path names as the lookup begins: one long line
    // took this thread, which answers every other request and terminal, for seconds (#3326).
    const authorized = TOOL_REF.test(ref) ? authorizedFile(resolved.path) : null;
    output = authorized === null ? null : await lettaToolOutputOffThread(resolved.path, ref, authorized, TOOL_OUTPUT_MAX);
    if (output !== null) {
      if (rebound(paneId, transcript)) return null;
      let fresh: NativeTranscript;
      try { fresh = await paneTranscript(paneId, codexHome, undefined, undefined, opencodeDb, hermesHome, grokHome, museData); }
      catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
      if (fresh.source !== transcript.source || fresh.path !== transcript.path || rebound(paneId, transcript)) return null;
    }
  } else output = resolved.source === "agy-transcript" ? await agyToolOutput(resolved.path, ref) : lookup();
  if (resolved.agy && !sameAgyStore(resolved.agy, await resolveAgyStore(pane))) return null;
  if (resolved.source === "copilot-transcript") {
    const current = await copilotTranscriptPath(pane, snapshot.panes, resolved.peerClaims).catch(() => null);
    if (current?.path !== resolved.path || current.binding !== resolved.binding) return null;
    try {
      if (!ref.startsWith(copilotPrefix(paneId, `${resolved.binding}\0${copilotHistoryIdentity(resolved.path)}`, resolved.path))) return null;
    } catch { return null; }
  }
  return live() ? output : null;
}

export function transcriptToolOutput(source: Exclude<StreamSource, "agy-transcript" | "letta-transcript">, path: string, ref: string, codexHome?: string): string | null {
  if (!TOOL_REF.test(ref) && !(source === "copilot-transcript" && /^[A-Za-z0-9_:.-]{1,128}@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/.test(ref))) return null;
  if (source === "codex-transcript") {
    let segments: ReturnType<typeof codexHistorySegments>;
    try { segments = codexHistorySegments(path, codexHome); } catch { return null; }
    for (const segment of segments) {
      let text: string;
      // a rollout may have been archived since resolution: the others still hold theirs. Each is read as the
      // file it was when its chain was resolved, and another file there answers nothing (readAuthorized)
      try {
        if (segment.identity) bindFile(segment.path, segment.identity);
        text = readRange(segment.path, 0, segment.end);
      } catch (error) {
        if (error instanceof ConversationReadPending) throw error;
        continue;
      }
      const output = outputInText(source, text, ref);
      if (output !== null) return output;
    }
    return null;
  }
  // each open of the log is held to the file the path names as the lookup begins (readAuthorized)
  if (source === "grok-transcript") return readAuthorized(path, () => grokToolOutput(path, ref));
  if (source === "muse-transcript") {
    const output = readAuthorized(path, () => museToolOutput(path, ref));
    return output !== null && output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  if (source === "pi-transcript" || source === "cmd-transcript") return piToolOutput(path, ref);
  if (source === "kimi-transcript") return readAuthorized(path, () => kimiToolOutput(path, ref, TOOL_OUTPUT_MAX));
  if (source === "omo-transcript") {
    try {
      const stream = transcriptStream(source, path, statSync(path), codexHome ?? defaultCodexHome());
      const from = windowStart(stream.length);
      const ranges = [...finish(linesWithSteps(stream, ref, from, stream.length)), ...finish(linesWithSteps(stream, "context_clear", from, stream.length))];
      const unique = new Map(ranges.map((range) => [range[0], range]));
      let output: string | null = null;
      const partialLead = from > 0 && readStream(stream, from - 1, from)[0] !== 0x0a;
      for (const [start, end] of [...unique.values()].sort((a, b) => a[0] - b[0])) {
        if (partialLead && start === from) continue;
        if (end - start > TOOL_OUTPUT_MAX) {
          const shape = finish(recordShapeSteps(stream, [start, end]));
          if (shape === UNREAD) return null;
          if (shape === NOT_A_RECORD) continue;
          if (isContextClear(shape.entry, source)) output = null;
          if (output !== null) continue;
          const message = piMessage(shape.entry);
          if (!message) continue;
          const blocks = message.role === "toolResult" ? [message] : Array.isArray(message.content) ? message.content.filter((item) => item && typeof item === "object" && item.type === "toolResult") : [];
          const block = blocks.find((item) => item && typeof item === "object" && (item as { toolCallId?: unknown }).toolCallId === ref) as { content?: unknown } | undefined;
          if (!block) continue;
          let result = "";
          let truncated = false;
          const text = (value: string): void => {
            if (truncated || result.length > TOOL_OUTPUT_MAX) return;
            truncated = !finish(scanStringSteps(stream, shape, value, TOOL_OUTPUT_MAX + 1 + IMAGE_SEARCH_WINDOW - result.length,
              (piece) => { result += piece.slice(0, TOOL_OUTPUT_MAX + 1 - result.length); }));
          };
          const content = block.content;
          if (typeof content === "string") text(content);
          else if (Array.isArray(content)) for (const item of content) if (item && typeof item === "object" && typeof item.text === "string") text(item.text);
          output = result;
          if (truncated || output.length > TOOL_OUTPUT_MAX) output = `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed`;
          continue;
        }
        const line = readStream(stream, start, end).toString("utf8");
        try { if (isContextClear(JSON.parse(line), source)) output = null; } catch { continue; }
        if (output === null) output = outputInText(source, line, ref);
      }
      return output;
    } catch { return null; }
  }
  if (source === "copilot-transcript") {
    let fd: number;
    try { fd = openCopilotFile(path); } catch { return null; }
    try {
      return ref.includes("@") ? copilotOffsetOutput(fd, ref, TOOL_OUTPUT_MAX) : copilotOutput(fd, ref, TOOL_OUTPUT_MAX);
    } finally { closeSync(fd); }
  }
  return readAuthorized(path, () => {
    let fd: number;
    try { fd = openBound(path); } catch { return null; }
    let text: string;
    try { text = readFileSync(fd, "utf8"); } catch { return null; } finally { closeSync(fd); }
    return outputInText(source, text, ref);
  });
}

/**
 * `read`, a lookup for an image or tool output, with the file `path` names now bound (readBound): null
 * where it names none, or where an open in the lookup finds another file there.
 */
function readAuthorized<T>(path: string, read: () => T | null): T | null {
  const authorized = authorizedFile(path);
  if (authorized === null) return null;
  try { return readBound([[path, authorized]], read); }
  catch (error) { if (error instanceof ConversationReadPending) return null; throw error; }
}

/**
 * A pi output lives on the active branch only: reading the
 * file whole would answer a ref from a branch a /tree abandoned, whose output the chat
 * never showed, so the branch is read the way the conversation is.
 */
function piToolOutput(path: string, ref: string): string | null {
  let size: number;
  let branch: ReturnType<typeof piBranchSegments>;
  try { size = statSync(path).size; branch = piBranchSegments(path, size); } catch { return null; }
  if (branch === null) return null;
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
    if (skillPromptMessage(entry) !== null || piNotice(entry) !== null || omoTaskResults(entry, new Map()) !== null || (entry as { type?: unknown }).type === "compaction") continue;
    const message = piMessage(entry);
    if (message === null) continue;
    if (tool !== null) {
      if (message.role === "assistant" && Array.isArray(message.content) && message.content.some((block: unknown) => { const call = block as { type?: unknown; name?: unknown; id?: unknown }; return call.type === "toolCall" && typeof call.name === "string" && call.id === id; })) open = true;
      if (open && piResults(message).some((result) => result.id === id)) { open = false; found = piImageBlock(message, id, Number(nth)) ?? undefined; }
    } else if (message.role === "user" && (entry as { id?: unknown }).id === id) {
      found = piPromptImages(entry, message).find((picture) => picture.ref === ref);
    }
  }
  return found ? { mediaType: found.media_type, bytes: new Uint8Array(Buffer.from(found.data, "base64")) } : null;
}

/**
 * It is read as the page reads omp, the file in one line after the last clear (one JSON writes with escapes
 * too, as the parser reads it), and as the parser draws it (parseOmpTranscript): a tool's picture only
 * from the first result that answers a call the page draws, a prompt's only from a prompt it draws.
 * omo writes its pictures inline the same way and its page reads the file the same way, so `source`
 * omo-transcript reads it so too, with no blob store (#3420); `exact` is the file its resolver proved
 * (omoFile), which every open is then held to instead of the file the path names as the lookup begins.
 */
export async function ompTranscriptImage(path: string, ref: string, anchor?: string | null, source: "omp-transcript" | "omo-transcript" = "omp-transcript", exact?: FileIdentity): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  // every open of the transcript, after each await too, is held to the file the path names as the lookup begins
  const authorized = authorizedFile(path);
  if (authorized === null) return null;
  try { return await finishAsync(boundSteps([[path, exact ?? authorized]], ompTranscriptImageSteps(path, ref, anchor, source))); } catch { return null; }
}

const RECORDS_PER_STEP = 32;

/**
 * `anchor` is the identity the blob store had when the transcript was
 * authorized (conversationImage: ompBlobAnchor); a blob is read only from that directory. Without one
 * (a caller that authorized nothing first), it is the store as this read starts.
 */
function* ompTranscriptImageSteps(path: string, ref: string, given: string | null | undefined, source: "omp-transcript" | "omo-transcript"): Steps<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const tool = PI_IMAGE_REF.exec(ref);
  const match = tool ?? PI_PROMPT_IMAGE_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const [, id, nth] = match;
  const blobs = source === "omp-transcript" ? ompBlobStore(path) : null;
  const anchor = blobs === null ? null : given === undefined ? ompBlobAnchor(blobs)?.identity ?? null : given;
  {
    const stream = transcriptStream(source, path, statSync(path), defaultCodexHome());
    yield* applyHistoryBoundarySteps(path, stream, source, true);
    const ranges = yield* linesWithSteps(stream, id, stream.floor, stream.length);
    const seen = new Set(ranges.map(([start]) => start));
    for (const range of yield* linesWithSteps(stream, "context_clear", stream.floor, stream.length)) if (!seen.has(range[0])) ranges.push(range);
    ranges.sort((left, right) => left[0] - right[0]);
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
      if (isContextClear(entry, source)) { open = false; found = null; continue; }
      if (found !== null) continue;
      if (skillPromptMessage(entry) !== null || piNotice(entry) !== null || omoTaskResults(entry, new Map()) !== null || (entry as { type?: unknown }).type === "compaction") continue;
      const message = piMessage(entry);
      if (message === null) continue;
      let content: unknown;
      if (tool !== null) {
        if (message.role === "assistant" && Array.isArray(message.content) && message.content.some((block: unknown) => { const call = block as { type?: unknown; name?: unknown; id?: unknown }; return call.type === "toolCall" && typeof call.name === "string" && call.id === id; })) open = true;
        if (!open) continue;
        const results = message.role === "toolResult" ? [message] : (Array.isArray(message.content) ? message.content : []).filter((block: unknown) => (block as { type?: unknown } | null)?.type === "toolResult");
        const result = (results as { toolCallId?: unknown; content?: unknown }[]).find((block) => block.toolCallId === id);
        if (result === undefined) continue;
        open = false;
        content = result.content;
      } else {
        if (message.role !== "user" || (entry as { id?: unknown }).id !== id) continue;
        content = message.content;
      }
      found = yield* ompPictureSteps(stream, shape, content, blobs, anchor, Number(nth));
    }
    return found === null ? null : { mediaType: found.mediaType, bytes: new Uint8Array(found.bytes) };
  }
}

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
 * It is read from the history the page reads (codexHistorySegments: the rollouts this one continues,
 * without the bytes a backtrack left behind) and as the parser draws it (parseCodexTranscript): only
 * from the first output answering a call it draws, and only the output's own pictures, never the copy an
 * image generation's event keeps.
 */
export async function codexToolImage(path: string, ref: string, codexHome: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const authorized = authorizedFile(path);
  if (authorized === null) return null;
  try { return await finishAsync(boundSteps([[path, authorized]], codexToolImageSteps(path, ref, codexHome))); } catch { return null; }
}

function* codexToolImageSteps(path: string, ref: string, codexHome: string): Steps<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const match = CODEX_TOOL_IMAGE_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const [, id, nth] = match;
  {
    const stream = transcriptStream("codex-transcript", path, statSync(path), codexHome);
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
  let native: string | null = null;
  // Code Mode: a REPL call whose script ran on answered `(dispatched #N)`; its output is in the events after it
  // (claude-code-mode.ts), under its number
  let script: { eval: number; parts: string[]; seen: Set<string> } | null = null;
  // the call's tool, from its tool_use: only a REPL's result is read as one
  let name: unknown = null;
  for (const line of text.split("\n")) {
    if (script !== null && line.includes("repl-eval")) {
      let entry: TranscriptEntry;
      try { entry = JSON.parse(line) as TranscriptEntry; } catch { continue; }
      const content = entry.message?.content;
      const delivered = entry.type === "attachment" && entry.attachment?.type === "poll_events"
        ? (Array.isArray(entry.attachment.envelopes) ? entry.attachment.envelopes : []).flatMap((envelope: unknown) => typeof envelope === "string" ? replDeliveries(envelope, true).outputs : [])
        : entry.type === "user" && Array.isArray(content) ? content.flatMap((block: unknown) => (block as { type?: unknown } | null)?.type === "tool_result" ? replDeliveries(claudeResultText((block as { content?: unknown }).content)).outputs : []) : [];
      for (const output of delivered) {
        const key = output.at ?? `${script.seen.size}`;
        if (output.eval !== script.eval || script.seen.has(key)) continue;
        script.seen.add(key);
        if (output.output.length > 0) script.parts.push(output.output);
      }
      continue;
    }
    if (!line.includes(needle) && !(source === "claude-transcript" && line.includes(hostNeedle))) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    let output: string | null = null;
    if (source === "claude-transcript") {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      const host = entryHostToolResults(entry, content).filter((result) => result.id === ref).at(-1);
      const result = Array.isArray(content) ? content.find((block) => (block as { type?: unknown; tool_use_id?: unknown } | null)?.type === "tool_result" && (block as { tool_use_id?: unknown }).tool_use_id === ref) : undefined;
      const use = entry.type === "assistant" && Array.isArray(content) ? content.find((block) => (block as { type?: unknown; id?: unknown } | null)?.type === "tool_use" && (block as { id?: unknown }).id === ref) : undefined;
      if (use !== undefined) name = (use as { name?: unknown }).name;
      if (host !== undefined) output = claudeResultText((content as unknown[]).slice(host.header + 1, host.end));
      else if (result !== undefined && native === null && !isHostHandoff(result as { content?: unknown; is_error?: unknown })) {
        native = claudeResultText((result as { content?: unknown }).content);
        const repl = name === REPL_TOOL && (result as { is_error?: unknown }).is_error !== true;
        const dispatched = repl ? replDispatched(native) : null;
        const own = repl && dispatched === null ? replOutput(native) : null;
        // a Code Mode Poll is drawn only for what it brought besides the scripts' output: that, as its row has it
        const other = name === POLL_TOOL ? replDeliveries(native).other : [];
        if (dispatched !== null) script = { eval: dispatched, parts: [], seen: new Set() };
        // a REPL's own output element, whose script's late output follows under its number
        else if (own !== null) {
          native = own.output;
          if (own.eval !== null) script = { eval: own.eval, parts: own.output.length > 0 ? [own.output] : [], seen: new Set() };
        } else if (other.length > 0) native = other.join("\n\n");
        // a script's call: its output is only in toolUseResult
        else if (native.length === 0) native = virtualCallOutput(entry) ?? native;
      }
    } else if (source === "codex-transcript") {
      const payload = entry.payload as { type?: unknown; call_id?: unknown; output?: unknown } | undefined;
      if ((payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output") && payload.call_id === ref) output = codexOutputText(payload.output);
    } else {
      const message = piMessage(entry);
      if (message) output = piResults(message).find((result) => result.id === ref)?.text ?? null;
    }
    if (output !== null) return output.length > TOOL_OUTPUT_MAX ? `${output.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : output;
  }
  if (script !== null && script.parts.length > 0) native = script.parts.join("\n");
  return native !== null && native.length > TOOL_OUTPUT_MAX ? `${native.slice(0, TOOL_OUTPUT_MAX)}\n… trimmed` : native;
}

/** Asset reads share the reset boundary even when their ref predates /clear. */
function activeHistoryText(text: string, source: RecognizedConversation["source"]): string {
  if (source === "codex-transcript") return text;
  let start = 0, offset = 0;
  for (const line of text.split("\n")) {
    if (line.includes("context_clear") || line.includes("/clear")) {
      try { if (isContextClear(JSON.parse(line), source)) start = offset + line.length + 1; } catch {}
    }
    offset += line.length + 1;
  }
  return text.slice(start);
}
