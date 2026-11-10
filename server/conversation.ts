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

import { createHash, randomUUID, type Hash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { open as openHandle, type FileHandle } from "node:fs/promises";
import { readStatuslineContext } from "./statusline.ts";
import { transcriptReader, type TranscriptFile } from "./transcript-reader.ts";
import nodePath, { basename, dirname, relative, sep, type PlatformPath } from "node:path";
import { isDshProcess, resolveDshTranscript, dshConversation, dshToolOutput, type DshTranscript } from "./dsh.ts";
import { isKiroChatProcess, resolveKiroTranscript, kiroConversation, kiroToolOutput, type KiroTranscript } from "./kiro.ts";
import { authorizedTranscript } from "./transcript-store.ts";

import type { ConversationMetadata, ConversationTurn, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { herdrRpc, herdrSocketPath, paneProcessInfo, paneRead, paneScrollInfo, sessionSnapshot, type ProcessInfo } from "./herdr/client.ts";
import { resolveAgent } from "./pane-context.ts";
import { codexFreshSession, codexHistorySegments, createCodexTranscriptParser, type HistorySegment, codexOutputText, codexTranscriptPath, defaultCodexHome, forgetAllCodexState, forgetCodexStateFor, paneCodexHomePlaced, parseCodexTranscript, readRange } from "./codex.ts";
import { awaited, CODEX_IMAGE_REF, CODEX_TOOL_IMAGE_REF, codexOutputPicture, codexTranscriptImage, DataUrlPictureScan, finish, finishAsync, forgetOmpBlobTypes, InlinePictureScan, MAX_IMAGE_BYTES, ompBlobAnchor, ompBlobDigest, ompBlobPictureSteps, type Steps } from "./codex-images.ts";
import { type Held, heldOpenPlatform, openHeldDirectory } from "./held-open.ts";
import { AmbiguousClaudeStore, claudeAttachSession, claudeProcessSession, claudeTranscriptFile, darwinProcess, defaultClaudeConfigDir, forgetClaudeSessionFile, forgetClaudeSessions, isClaudeProcess, jobClaude, processClaudeConfigDir, windowsShellClaude } from "./claude-store.ts";
import { coreSocket } from "./herdr-core/discovery.ts";
import { coreSocketPath } from "./herdr-core/runtime.ts";
import { capabilities } from "./runtime/capabilities.ts";
import { forgetGjcPane, forgetGjcState, gjcPidUnderShell, gjcTranscriptFileForPane, isGjcProcess, storeRelative } from "./gjc-runtime.ts";
import { isOmoProcess, omoProcessIdentity, omoSessionForPane, processEnviron } from "./omo.ts";
import { processAlive, processStartedAtAsync } from "./process-start.ts";
import { ompBlobStore, ompHeldOpen, ompPaneRoute, ompRouteOwns, ompRouteStore, ompRouteTranscript } from "./omp.ts";
import { forgetOpencodeRead, forgetOpencodeState, OPENCODE_IMAGE_REF, opencodeConversation, opencodeDatabasePath, opencodeImage, opencodeReadKey, opencodeSessionId, opencodeToolOutput } from "./opencode.ts";
import { piTranscriptPath, unwrittenSession } from "./pi.ts";
import { cmdTranscriptPath } from "./cmd.ts";
import { defaultDevinDbPath, DevinHistoryUnavailable, devinConversation, forgetDevinState } from "./devin.ts";
import { forgetGrokState, GROK_IMAGE_REF, grokImage, grokProjection, grokToolOutput, parseGrokTranscript, GrokUnavailable } from "./grok.ts";
import { resolveGrokStore } from "./grok-store.ts";
import { AGY_CATALOG_BYTES, AgyUnavailable, agyCatalogOffThread, agyDatabasePath, agyToolOutput, forgetAgyState, parseAgyTranscript, withAgyHistory, type AgyProjection } from "./agy.ts";
import { agyFreshSession, resolveAgyStore, sameAgyStore, type AgyStore } from "./agy-store.ts";
import { FileBusyError } from "./file-pool.ts";
import { museSession, museToolOutput, MuseUnavailable, parseMuseTranscript } from "./muse.ts";
import { resolveMuseSession } from "./muse-store.ts";
import { LettaUnavailable, lettaToolOutputOffThread, parseLettaTranscript } from "./letta.ts";
import { programName } from "./agent-identity.ts";
import { lettaLocalSettings, resolveLettaTranscript } from "./letta-store.ts";
import { followKimiUndo, kimiToolOutput, kimiTranscriptPathForPane, parseKimiTranscript, type KimiUndo } from "./kimi.ts";
import { withinRetentionBudget } from "./retention-budget.ts";
import { forgetAllPiIndexes, forgetPiIndex, piAbandonedTurns, piBranchRecords, piBranchSegments } from "./pi-tree.ts";
import { COPILOT_IMAGE_REF, copilotImage, copilotOffsetOutput, copilotOutput, copilotRootRecord, parseCopilotTranscript } from "./copilot.ts";
import { copilotApiTranscript, copilotExplicitResume, copilotHandoffSession, copilotProcessSession, copilotTranscriptFile, copilotUnwrittenSession, openCopilotFile, readCopilotProcessSession } from "./copilot-store.ts";
import { forgetCopilotForeground, readCopilotForeground } from "./copilot-foreground.ts";
import { claudeSetting, parseConversationMetadata } from "./conversation-metadata.ts";
import { answerVersion, bindFile, boundSteps, checkBoundFile, ConversationNotStarted, ConversationReadPending, ConversationUnavailable, copilotRecoverable, type FileIdentity, openBound, readBound, type ConversationPage, HistoryChanged, type RecognizedConversation, type StreamSource, TRANSCRIPT_WINDOW_BYTES } from "./conversation-shared.ts";
import { forgetHermesTranscriptState, hermesConversationPage, hermesToolOutput, hermesTranscriptForPane } from "./hermes.ts";

import { createOmpTranscriptParser, isContextClear, MAX_TURNS, omoTaskResults, parseOmpTranscript, PI_IMAGE_REF, PI_PROMPT_IMAGE_REF, piImageBlock, piMessage, piNotice, piPromptImages, piResults, type TranscriptParser } from "./transcript-records.ts";
import { skillPromptMessage } from "./skill-activity.ts";
import { CLAUDE_IMAGE_REF, claudeImageType, claudeResultText, createClaudeTranscriptParser, entryHostToolResults, isHostHandoff, parseClaudeTranscript, type TranscriptEntry } from "./claude-transcript.ts";
import { forgetSubagents, lineNotifications, subagentDetails, type SubagentDetail } from "./claude-subagents.ts";
import { launchedAgents } from "./launched-agents.ts";
import { readsStartScreen, startScreenMetadata } from "./start-screen.ts";
import { commandTranscriptRecords, PI_EVIDENCE_TYPES, type CommandTranscriptRecord } from "./outcome.ts";
import { type ClaudeBranch, claudeForks, followClaudeBranch, type PromptChain, turnStarts } from "./transcript-turns.ts";
import { copilotSetAside } from "./copilot.ts";
import { DevinLockMissing, devinLockProof, devinSessionForPane, isDevinProcess, type DevinLockProof } from "./devin-session.ts";
import { userHome } from "./user-home.ts";
import { kiroCodexProcess } from "./kiro-terminal.ts";

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
/**
 * How far back a Copilot page reaches for the start of its turn: Copilot interns every picture of a
 * turn in it as base64 (`session.binary_asset`), so one turn with a few pictures passes a window
 * (#2478). Its pages widen to the turn's start, the newest one too, up to this.
 */
const COPILOT_PAGE_BYTES = 4 * MAX_PAGE_BYTES;

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
  /** the shared reader's lease on the one file the stream is (a Claude image read): its bytes come by async positional reads (streamBytes) */
  file?: TranscriptFile;
  /** byte ranges a Claude rewind left off the session's branch (claudeBranch): read as blank lines */
  hidden?: [number, number][];
  /** A cooperative image scan publishes only while its file snapshot is current. */
  current?: () => Steps<boolean>;
  /** the history boundary a private (`apart`) scan of this stream published to clearScans, so a rejected image read can take it back */
  published?: { scan: object; through: number };
  /** what the history boundary scan read, from `from` to the stream's end, digested a window at a time, when an image read keeps it */
  seen?: { from: number; digest: bigint };
  /** where the boundary scan found the Claude records that hold pictures (PictureIndex) */
  pictures?: PictureIndex;
  /**
   * a Claude transcript's version as this read found it (identity, size and times), and when the read
   * began: performance.now(), and Date.now() to set beside the file's times (vouchedPictureSteps)
   */
  version?: { key: string; mtimeMs: number; ctimeMs: number; began: number; wall: number };
}

// In-place rewrites keep the inode. Change the cursor generation when observed,
// invalidating settled turns and incremental parsers as well as the response cache.
// `hash` digests the first `hashed` bytes, fed only what each growth appends. `prefix` is the digest of
// the first PREFIX_BYTES (or all) of the `at` bytes the last reading call saw. `forced`: the generation
// was given to a growth no digest checked; until a read checks the digests kept from before it, a growth
// no digest checks keeps it.
interface TranscriptRevision { identity: string; size: number; changed: string; generation: string; hash?: Hash; hashed: number; prefix?: { digest: string; at: number }; window?: { start: number; end: number; digests: BigUint64Array }; forced?: true }
const transcriptRevisions = new Map<string, TranscriptRevision>();
const PREFIX_BYTES = 64 * 1024;
type RevisionStat = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
// `read` false (a leased image read, whose bytes come asynchronously) never reads the file here: the
// digest stays as it was, for the next read to extend, and a touch it sees counts as a rewrite.
function transcriptGeneration(path: string, stat: RevisionStat, checkWindow = false, read = true): string {
  const reads = revisionReads;
  const deferred = read && reads.mode === "deferred" ? reads : null;
  let wanted = false as boolean;
  const opened: RevisionOpen = deferred === null ? openRevisionNow : function* () { wanted = true; throw new Error("left to settleTranscriptRevision"); };
  const { previous, next: found } = finish(transcriptRevisionSteps(path, stat, checkWindow, read && reads.mode !== "none", opened));
  let next = found;
  // a revision it could not check: the read stops here, before it parses anything, records nothing, and
  // readSettled settles again off the loop
  if (deferred !== null && wanted) {
    deferred.unsettled = true;
    throw new Error("transcript revision left to settleTranscriptRevision");
  }
  // A growth no digest checked (the last settle reads nothing) may be a rewrite that also grew. It is
  // pending once, for the next poll to check; after that, or where no settle can read it (a link), it is
  // another history, never the one before it.
  // That history then stays while the writes go on (`forced`), and keeps the digests from before it, so
  // the read that can check them finds the first bytes of a rewrite, and an append extends them.
  if (read && reads.mode === "none" && next.forced !== true && previous?.identity === next.identity && next.generation === previous.generation && previous.size > 0 && next.size > (next.prefix?.at ?? previous.size)) {
    if (reads.verifiable && !uncheckedGrowths.has(path)) {
      remember(uncheckedGrowths, path, true, 64);
      throw new RevisionUnchecked();
    }
    // a link's digests are never checked: its next growth is measured from here
    next = reads.verifiable ? { ...next, generation: randomUUID(), forced: true } : { ...next, generation: randomUUID(), hash: undefined, hashed: 0, prefix: undefined };
  }
  if (read) uncheckedGrowths.delete(path);
  remember(transcriptRevisions, path, next, 64);
  return next.generation ? `-${next.generation}` : "";
}

/**
 * How a synchronous page read's revision check reads the transcript: on the event loop (anywhere
 * readSettled is not running one); "deferred", where any read it needs marks it `unsettled` instead, for
 * readSettled to settle again off the loop; or "none", reading nothing (a touch then counts as a rewrite, and
 * a growth is pending once where a later settle can check it, `verifiable`, and another history otherwise).
 */
let revisionReads: { mode: "inline" } | { mode: "deferred"; unsettled: boolean } | { mode: "none"; verifiable: boolean } = { mode: "inline" };

/** Transcripts whose last read was pending on a growth no digest checked: their next one answers. */
const uncheckedGrowths = new Map<string, true>();

/** A read pending on a growth no digest checked: no other file is involved, so nothing is recovered for it. */
class RevisionUnchecked extends ConversationReadPending {}

/** What settleTranscriptRevision brings up to date, and whether its reader still wants it recorded (`live`). */
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

/** Whether `path` still names the file `authorized` (authorizedFile). */
function stillAuthorized(path: string, authorized: ReturnType<typeof authorizedFile>): boolean {
  if (authorized === null) return false;
  try {
    const now = statSync(path);
    return now.dev === authorized.dev && now.ino === authorized.ino;
  } catch { return false; }
}

/**
 * Brings a transcript's revision up to date with reads through the thread pool, so the page read that
 * follows finds its digests current and reads nothing for them on the event loop. Only `authorized` is
 * read, through one handle: a folder on the way swapped since names another file, which is refused, and
 * bytes whose size or mtime changed while they were read record nothing. A read that recorded the
 * transcript meanwhile keeps its own result; a change after this is the page read's (readSettled).
 */
async function settleTranscriptRevision({ path, checkWindow, live }: RevisionTarget, authorized = authorizedFile(path)): Promise<void> {
  // what this settle builds on: a read that recorded the transcript while its stat was awaited saw it
  // later, and an older stat checked against that newer revision would take an append for a shrink
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
      *close() { /* the handle is this settle's, closed below */ },
    };
    const { previous, next } = await finishAsync(transcriptRevisionSteps(path, stat, checkWindow, true, function* () { return file; }));
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return;
    if (transcriptRevisions.get(path) === previous && (live?.() ?? true)) remember(transcriptRevisions, path, next, 64);
  } catch { /* a stat that fails digests nothing */ } finally { await handle.close().catch(() => {}); }
}

/**
 * The transcript a readSettled page read reads, opened once as authorized: readStream reads it through this
 * handle. The other files a page holds (a Codex rollout before the live one) are opened bound (openBound).
 */
let pageFile: { path: string; fd: number } | null = null;
// a link is followed, as the page readers do; O_NONBLOCK: a FIFO put there is not waited on
const PAGE_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * How many times readSettled settles a transcript before its read takes what it finds without reading;
 * a transcript reached through a link, which no settle opens, takes it at once.
 */
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
      // a read that met an unsettled revision answered from a stale one: its failure says nothing
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
  // times about hourly, bytes untouched). The digest of the bytes digested before tells them apart;
  // bytes that cannot be read count as a rewrite.
  if (same && stat.size === previous.size && changed !== previous.changed) {
    const now = read && hash ? (yield* hashRange(opened, path, stat, createHash("sha256"), 0, hashed)) : undefined;
    if (!now || now.copy().digest("base64") !== hash!.copy().digest("base64")) rewritten = true;
  }
  // A growth of the same inode is taken for an append, and `hash` is only extended by it. Its first
  // bytes must still be the ones read before (an earlier rewrite while growing would otherwise keep
  // the generation, and a same-size restore later match the extended digest). ponytail: only the first
  // 64 KiB, a growing read stays about as cheap as before; a rewrite past them while growing still
  // passes. A leased read leaves `prefix` at the size it checked, for the next read to check.
  let prefix = same && !rewritten ? previous.prefix : undefined;
  let head: Hash | undefined;
  if (read && prefix && stat.size > prefix.at) {
    head = yield* hashRange(opened, path, stat, createHash("sha256"), 0, Math.min(PREFIX_BYTES, prefix.at));
    if (!head || head.copy().digest("base64") !== prefix.digest) { rewritten = true; head = undefined; }
  }
  // a growth no digest of its first bytes vouches for (none was kept: a link, or a read that failed) may be a
  // rewrite; an empty file had none to rewrite
  if (read && same && !rewritten && prefix === undefined && previous.size > 0 && stat.size > previous.size) rewritten = true;
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
    const bytes = yield* windowBytes(opened, path, stat, from);
    const digests = bytes && chunkDigests(bytes);
    if (check && (!digests || !sameOverlap(check, from, bytes!, digests))) rewritten = true;
    // an empty log keeps no window: it has no bytes to check
    const kept = digests?.slice((start - from) / WINDOW_CHUNK_BYTES);
    window = kept?.length ? { start, end: stat.size, digests: kept } : undefined;
  }
  // A first read (or one after a rewrite) digests the whole file, a growth only what it appended.
  // Only a log within one window keeps a digest, so no read goes past the transcript budget; a
  // larger log's touch counts as a rewrite, as before.
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
  // only a read that checked nothing leaves a forced generation as it was
  const forced = !read && same && !rewritten && previous.forced === true;
  return { previous, next: forced ? { identity, size: stat.size, changed, generation, hash, hashed, prefix, window, forced } : { identity, size: stat.size, changed, generation, hash, hashed, prefix, window } };
}

/** The revision check's file: read on the event loop (finish) or through the thread pool (finishAsync). */
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

/**
 * `hash` fed bytes `from` to `to` of a file a chunk at a time, or undefined when they cannot all be read
 * or the path no longer names the regular file `stat` saw, holding at least `to` bytes, before and after
 * the read (an append meanwhile leaves them alone).
 */
function* hashRange(opened: RevisionOpen, path: string, stat: { dev: number; ino: number }, hash: Hash, from: number, to: number): Steps<Hash | undefined> {
  const unchanged = (now: Stats): boolean => now.isFile() && now.dev === stat.dev && now.ino === stat.ino && now.size >= to;
  try {
    const file = yield* opened(path);
    try {
      if (!unchanged(yield* file.stat())) return undefined;
      // 64 KiB at a time: a check, not a page read, so a page read's failure is its own
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

/**
 * Bytes `from` to `stat.size` of a file, or null when they cannot all be read or the path no longer names
 * the regular file `stat` saw, holding at least that many bytes, before and after the read.
 */
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
  // (a chain whose parent was archived since comes back shorter: codexHistorySegments;
  // a pi branch skips the side paths a /tree left behind: piBranchSegments)
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
  const version = source === "claude-transcript"
    ? { key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, began: performance.now(), wall: Date.now() } : undefined;
  return { id: `${stat.dev.toString(36)}-${stat.ino.toString(36)}${chain}${transcriptGeneration(path, stat, source === "muse-transcript", !leased)}`, files, length: stream, floor: 0, promptStarts: grok?.promptStarts ?? agy?.promptStarts, fd, version };
}

/** readStream's bytes in `into`, which holds them until the caller reads into it again: no buffer is allocated. */
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
 * readStream in steps: a lease's bytes (`stream.file`) are waited for (awaited), never read on the
 * event loop. What one window holds comes in the lease's own buffer, not a new one: it holds only
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
    // the lease's buffer: valid until the next read on this lease, so the caller takes it in first
    return hideOffBranch(stream, bytes, from, to);
  }
  return yield* awaited((async () => {
    const chunks: Buffer[] = [];
    for (const segment of stream.files) {
      const low = Math.max(from, segment.start);
      const high = Math.min(to, segment.start + segment.length);
      if (low >= high) continue;
      // as readSync fills it: a window at a time, what a short read leaves at the end cut off. Each is read
      // straight into its place, not into the lease's window to be copied out (a range of 16 MiB was copied whole)
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
/** The most one read of a lease takes (TranscriptFile.window). */
const LEASE_WINDOW_BYTES = 1024 * 1024;

function hideOffBranch(stream: TranscriptStream, bytes: Buffer, from: number, to: number): Buffer {
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
const KIMI_SETTING_TYPES = ['"llm.request"'];
type SettingType = "model_change" | "thinking_level_change" | "copilot_model" | "copilot_effort" | "kimi_request";
/**
 * Claude names its model and effort on every answer, and a /rewind can leave any of them off the
 * branch, so each field keeps every record that set it since the last clear (where it lies, as
 * `branch.answers` does) and a small line that sets the same value again, shared while it repeats.
 */
type ClaudeSettings = Record<"model" | "effort", { line: string; start: number; end: number }[]>;
const clearScans = new Map<string, { id: string; scanned: number; floor: number; tail: string; settings: Partial<Record<SettingType, { offset: number; end: number; line: string }>>; branch?: ClaudeBranch; claude?: ClaudeSettings; pictures?: PictureIndex; undo?: KimiUndo }>();

/**
 * Where a Claude transcript's pictures are, as the boundary scan reads past them, so a lookup goes
 * straight to the record a ref names instead of searching the transcript for it. `at` holds a user
 * record with a picture by its uuid, only when it is the first record since the last /clear with
 * that uuid: then it is the record claudePictureSteps' search would find first. A uuid seen before
 * (on a record the branch follows, in `ends`, or on one it does not, in `loose`) is left out, and so
 * is every record after `blind`, where a record too long to follow starts: those are searched for.
 * `unread` holds the records since the /clear the endpoint may not judge (mayBeUnread): the search
 * refuses at one that names what it looks for, so a lookup with one before its record or its call
 * searches as well.
 *
 * `bytes` digests what it was built from, so a scan kept from before an in-place rewrite of any of it
 * is found out (vouchedPictureSteps), and `vouched` is the file's version a read of those bytes last
 * matched, with when that read began (performance.now(), and Date.now()).
 */
interface PictureIndex { at: Map<string, IndexedPicture>; loose: UuidMarks; blind: number | null; unread: [number, number][]; bytes: PictureBytes; vouched: ({ key: string } & PictureRead) | null }
/** a read of a file's bytes: when it began, by performance.now(), and by Date.now() to set beside the file's times */
interface PictureRead { began: number; wall: number }
/**
 * The bytes an index was built from, [from, through): chained xxHash3 digests of PICTURE_DIGEST_BYTES
 * pieces at fixed offsets up to `hashed` (the first piece starts at `from`), and what comes after, kept
 * as it is until its piece is whole, so a scan that goes on later digests the same pieces.
 */
interface PictureBytes { from: number; hashed: number; digest: bigint; pending: Uint8Array; through: number }
const PICTURE_DIGEST_BYTES = 64 * 1024;
/** a record the index holds: where it starts and where it ends (at its newline) */
interface IndexedPicture { start: number; end: number }

/**
 * The uuids of records the branch does not follow (a sidechain's, most of all), by a 32-bit digest
 * each. A scan appends each to `log`, which costs about what hashing it does; a picture's record looks
 * them up in `table` (open addressing, kept at most half full, 0 is no uuid) and then through what is
 * logged. The log is folded into the table once lookups have read it MARKS_FOLD_AFTER times over, so
 * a file of few pictures never builds the table, and one of many lookups does not read a long log
 * each time. Two uuids with one digest read as seen, which only sends a lookup to the search.
 * Past MARKS_LIMIT marks since the /clear none is kept (`full`): every uuid would read as seen, so
 * the scan indexes no more records (notePicture).
 */
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
/** an index of no pictures, of the bytes from `from` on, which the read `stream` makes now */
const noPictures = (from: number, stream: TranscriptStream): PictureIndex => ({
  at: new Map(), loose: { table: new Uint32Array(0), count: 0, log: new Uint32Array(0), logged: 0, read: 0, full: false }, blind: null, unread: [],
  bytes: { from, hashed: from, digest: 0n, pending: new Uint8Array(0), through: from },
  vouched: stream.version ? { key: stream.version.key, began: performance.now(), wall: Date.now() } : null,
});
/** the end of the digest piece `at` is in (PictureBytes) */
const pieceEnd = (at: number): number => (Math.floor(at / PICTURE_DIGEST_BYTES) + 1) * PICTURE_DIGEST_BYTES;
/** Digests what of `data`, the bytes at `at` on, lies past what `bytes` holds (a scan reads some of them again). */
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

/**
 * Whether the endpoint may not judge this record (recordShapeSteps' UNREAD, or a call id callIdSteps
 * does not read): its shape can pass SHAPE_MAX_BYTES, or it is long enough to hold a string past
 * PICTURE_TEXT_BYTES. The shape keeps each string's first SHAPE_STRING_BYTES and at most an escape
 * more, then a mark of under 60 bytes in place of the rest, so a string of `length` bytes adds at most
 * SHAPE_STRING_BYTES + 64 - length to it, and the record's own length is the rest.
 */
function mayBeUnread(line: Buffer): boolean {
  if (line.length > PICTURE_TEXT_BYTES) return true;
  const longest = SHAPE_STRING_BYTES + 64;
  if (line.length * (longest / SHAPE_STRING_BYTES) <= SHAPE_MAX_BYTES) return false;
  let shape = line.length;
  // the strings as recordShapeSteps reads them: a backslash takes the byte after it, and a \u four more
  let slash = line.indexOf(0x5c);
  for (let open = line.indexOf(0x22); open !== -1; open = line.indexOf(0x22, open)) {
    let at = open + 1;
    for (;;) {
      const quote = line.indexOf(0x22, at);
      // a string the line does not close keeps what is left of it whole
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

/** Index the record followClaudeBranch just read (`line`, [start, newline)), when it holds a picture; `known` is how many uuids `ends` held before it. */
function notePicture(index: PictureIndex, ends: Map<string, number>, known: number, parsed: unknown, line: Buffer, start: number, newline: number): void {
  // past MARKS_LIMIT no mark is kept and every uuid reads as seen: no record is indexed, and none is hashed
  if (index.loose.full) return;
  const entry = parsed as TranscriptEntry | null | undefined;
  if (entry === null || typeof entry !== "object" || typeof entry.uuid !== "string") return;
  const followed = ends.get(entry.uuid) === newline + 1;
  // the uuid is hashed only when it is kept or a picture's record asks: most records are neither
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
function* applyHistoryBoundarySteps(path: string, stream: TranscriptStream, source: RecognizedConversation["source"], apart: boolean, fresh = false): Steps<void> {
  if (source === "codex-transcript" || source === "grok-transcript" || source === "agy-transcript" || source === "muse-transcript" || source === "letta-transcript") return;
  const previous = clearScans.get(path);
  const previousScanned = previous?.scanned;
  // a file rewritten since a boundary was kept can still end in the tail that boundary is checked by
  let scan = fresh ? undefined : previous;
  if (!scan || scan.id !== stream.id || scan.scanned > stream.length || (yield* bytesBeforeSteps(stream, scan.scanned)) !== scan.tail) {
    scan = { id: stream.id, scanned: 0, floor: 0, tail: "", settings: {}, ...(source === "claude-transcript" ? { branch: { last: null, ends: new Map(), answers: [], forks: [] }, claude: { model: [], effort: [] }, pictures: noPictures(0, stream) } : {}), ...(source === "kimi-transcript" ? { undo: { anchors: [], undone: [] } } : {}) };
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
        } catch { /* not a record */ }
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
      if (!skipping && scan.pictures && mayBeUnread(line)) scan.pictures.unread.push([base + offset, base + newline]);
      skipping = false;
      offset = newline + 1;
      scan.scanned = base + offset;
      if (++judged % RECORDS_PER_STEP === 0) yield;
    }
    if (scan.pictures) digestPictureBytes(scan.pictures.bytes, bytes, base);
    carry = bytes.subarray(offset);
    // An oversized data record cannot be a native clear control envelope; a Claude prompt that is a
    // screenshot can still be where the session's branch forks
    if (carry.length > (branch ? CLAUDE_CARRY_BYTES : METADATA_HEAD_BYTES)) {
      if (scan.pictures && scan.pictures.blind === null) scan.pictures.blind = base + offset;
      // a user's message (Kimi names a record's type and a message's role first) may be a prompt: an
      // /undo counting back over it would take back another
      if (scan.undo && carry.subarray(0, 512).includes('"context.append_message"') && carry.subarray(0, 512).includes('"role":"user"')) scan.undo.anchors = [];
      carry = Buffer.alloc(0);
      skipping = true;
    }
    position = end;
    if (position < stream.length) yield;
  }
  scan.tail = yield* bytesBeforeSteps(stream, scan.scanned);
  stream.pictures = scan.pictures;
  // A page read can advance the same cached object while this private copy is paused, also while
  // the file's check is on its way: what is kept is checked again once it answers.
  const kept = () => clearScans.get(path) === previous && previous?.scanned === previousScanned;
  if (!apart || (kept() && (stream.current === undefined || ((yield* stream.current()) && kept())))) {
    remember(clearScans, path, scan, 32);
    if (apart) stream.published = { scan, through: scan.scanned };
  }
  // A valid final JSON object is visible before its newline; rescan it on append.
  stream.floor = !skipping && carry.length > 0 && isClear(carry) ? stream.length - carry.length : scan.floor;
  if (stream.floor > 0) stream.id += `-clear-${stream.floor.toString(36)}`;
  // what a Kimi /undo took back reads as off the branch too, the final record's before its newline
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
    // the branch moved: what was read before reads otherwise now, as after a clear
    stream.id += `-fork-${hidden.length}-${hidden.at(-1)![1].toString(36)}`;
  }
}

/**
 * The page of turns ending at `to`: at most MAX_PAGE_PROMPTS prompts, starting on a
 * line that opens a turn, at `floor` (a held start) or at the very beginning. An
 * older page is read once, so for a turn longer than a window it reaches further
 * back, a new chunk at a time, up to MAX_PAGE_BYTES. The newest page is read on
 * every append, so it never does, but for Copilot's (COPILOT_PAGE_BYTES): with no turn
 * start in its window it starts mid-turn, at a whole line.
 */
function pageBefore(stream: TranscriptStream, source: StreamSource, to: number, { floor = stream.floor, widen, prompts }: { floor?: number; widen: boolean; prompts: number }): { start: number; bytes: Buffer } {
  let from = Math.max(floor, to - TRANSCRIPT_WINDOW_BYTES);
  const bytes = readStream(stream, from, to);
  // the bytes searched for turn starts: the window, then each chunk widening adds before it
  let searched = bytes;
  for (;;) {
    const starts = stream.promptStarts ? stream.promptStarts.filter((at) => at >= from && at < from + searched.length).map((at) => at - from) : turnStarts(searched, source, undefined, turnBlobs(stream, source));
    const keep = starts.length > prompts ? starts[starts.length - prompts] : from === floor ? 0 : starts[0];
    // a start found while widening is read from once, not built up a chunk at a time
    if (keep !== undefined) return searched === bytes ? { start: from + keep, bytes: bytes.subarray(keep) } : { start: from + keep, bytes: readStream(stream, from + keep, to) };
    if (!widen || to - from >= (source === "copilot-transcript" ? COPILOT_PAGE_BYTES : MAX_PAGE_BYTES)) {
      const firstLine = bytes.indexOf(0x0a) + 1;
      return { start: to - bytes.length + firstLine, bytes: bytes.subarray(firstLine) };
    }
    // no start in what was searched: only the new chunk can hold one, and the line it cuts ends past it
    const next = Math.max(floor, from - TRANSCRIPT_WINDOW_BYTES);
    const pieces = [readStream(stream, next, from)];
    for (let at = from; at < to;) {
      const piece = readStream(stream, at, Math.min(to, at + IMAGE_SEARCH_WINDOW));
      // a file cut short since its size was taken reads nothing more: what was read is searched
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

function* bytesBeforeSteps(stream: TranscriptStream, offset: number): Steps<string> {
  return (yield* streamBytes(stream, Math.max(0, offset - 64), offset)).toString("latin1");
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

/**
 * The transcript each pane was last resolved to, numbered: a resolution naming another one than the last
 * takes a new number, and a forgotten pane has none. A read that awaited after its resolution compares
 * the number it was resolved under with the pane's (rebound), so it learns whether the pane was seen bound
 * elsewhere meanwhile without asking herdr again.
 */
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

/**
 * The newest Copilot turn that has outgrown its window (#2478), kept between polls: where it starts,
 * how far it was read and the bytes just before that, and its complete lines, a picture record as its
 * length only (copilotSetAside). A poll reads only what was appended since; another history, a file
 * whose bytes before the read point changed, a new prompt, or a turn grown a window past the cap is
 * read afresh. Like liveScans it trusts Copilot to append: an earlier line rewritten in place, with
 * the bytes before the read point kept and the file grown, is not noticed.
 */
interface CopilotTurnScan { id: string; start: number; scanned: number; tail: string; lines: { at: number; line: string }[]; bytes: number }
const copilotTurnScans = new Map<string, CopilotTurnScan>();
/** What every kept turn's lines may come to together: one turn as far as a page reaches before it is found afresh. */
const COPILOT_TURN_SCAN_BYTES = COPILOT_PAGE_BYTES + TRANSCRIPT_WINDOW_BYTES;

function forgetCopilotTurns(path: string): void {
  for (const key of copilotTurnScans.keys()) if (key.startsWith(`${path}\0`)) copilotTurnScans.delete(key);
}

/** The newest Copilot page that begins before its window: its start, its complete lines and the last line still being written. */
function copilotNewestTurn(path: string, stream: TranscriptStream, prompts: number): { start: number; lines: CopilotTurnScan["lines"]; partial: string } {
  const key = `${path}\0${prompts}`;
  let scan = copilotTurnScans.get(key);
  let bytes: Buffer | null = null;
  // a turn grown a window past the cap is found afresh, so a page still ends up at most about the cap
  if (scan && scan.id === stream.id && scan.scanned <= stream.length && stream.length - scan.start <= COPILOT_PAGE_BYTES + TRANSCRIPT_WINDOW_BYTES
    && bytesBefore(stream, scan.scanned) === scan.tail) {
    bytes = readStream(stream, scan.scanned, stream.length);
    // a prompt appended since starts a newer turn: the page is found afresh from it
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
  // kept by bytes too, least recently read first out, and never a turn past the whole budget
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
      : parseOmpTranscript(text, Infinity, ompReading(source, path, taskTitles));
}

/** How the omp record fold reads a source, the same for a one-shot parse and a live one: pi and omo keep a
 * picture inline (an omo tool's display() or image read, #3420) and omp in its blob store, and the image
 * endpoint answers all three; gjc is read the same way but would carry image refs nothing answers, so it
 * names none. gjc's tool parts carry their call ids, which the chat matches gjc's rewrites by */
function ompReading(source: RecognizedConversation["source"], path: string, taskTitles?: Map<string, string>) {
  return { images: source === "pi-transcript" || source === "cmd-transcript" || source === "omp-transcript" || source === "omo-transcript", blobs: source === "omp-transcript" ? ompBlobStore(path) : null, callIds: source === "gjc-transcript", taskTitles };
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

/**
 * Forgets so far, and the last one of each pane or of every pane (the floor): a read that awaited sees
 * whether its pane was forgotten meanwhile (forgottenSince). A pane's mark pushed out by newer ones
 * raises the floor, so a read of that pane in flight still sees it (and one of another pane takes it
 * for its own, and fails once).
 */
let forgets = 0;
let forgottenFloor = 0;
const forgottenPanes = new Map<string, number>();
const forgottenSince = (paneId: string, at: number): boolean => forgottenFloor > at || (forgottenPanes.get(paneId) ?? 0) > at;

/** Forget every scan and parse kept between polls (tests compare against a cold read). */
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

/**
 * Drop everything one pane's chat parsed, the caches here and in the readers below.
 *
 * The maps are keyed by file, so the pane is remembered against what it read
 * (`rememberPaneRead`). Every delete is a memo of a file that still exists: the next read
 * of a live pane re-derives it, and a file nobody reads again costs nothing to forget.
 */
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

/** gjc's resolver answers null; the chat lens reports why it fell back to scrollback. */
export async function gjcTranscriptPath(paneId: string, cwd: string, home?: string, known?: KnownProcesses): Promise<string> {
  return (await gjcTranscriptFile(paneId, cwd, home, known)).path;
}

/** gjcTranscriptPath, with the exact dev:ino of the file the resolver proved (`identity`). */
async function gjcTranscriptFile(paneId: string, cwd: string, home?: string, known?: KnownProcesses): Promise<{ path: string; identity: string }> {
  const found = known === undefined ? await gjcTranscriptFileForPane(paneId, cwd, home) : await gjcTranscriptFileForPane(paneId, cwd, home, { known });
  if (!found) throw new ConversationUnavailable("no_session_path");
  return found;
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
  const matched = agent && ["claude", "codex", "omp", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy", "copilot", "letta"].includes(agent)
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
  // an environment read empty is a process gone or not ours to read
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
    } catch { return []; /* herdr busy: the default store */ }
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
async function claudeTranscriptPath(paneId: string, cwds: readonly (string | null | undefined)[], onProcess?: (pid: number, attach: boolean) => void, known?: KnownProcesses, proofs?: Map<string, string>): Promise<string> {
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
  const path = await claudeTranscriptFile(home, session, cwds, configDir, live, proofs);
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

/** `identity`: the authorized file's exact dev:ino (authorizedTranscript), so later reads can be held to it. */
export async function ompTranscriptPath(paneId: string, cwd: string, known?: KnownProcesses): Promise<{ path: string; blobs: string | null; identity?: string }> {
  const info = await herdrRpc<{ agent: { agent_session?: { kind?: unknown; value?: unknown } } }>("agent.get", { target: paneId });
  const session = info.agent.agent_session;
  const path = session?.kind === "path" && typeof session.value === "string" ? session.value : null;
  const home = userHome();
  let route = process.platform === "win32" ? null : await ompPaneRoute(paneId, known);
  // the caller's read named no omp (none in front, only the shell, or one gone since): an omp started after it may
  // keep another store than the session herdr still reports, so the pane is asked again
  if (route === null && known != null && process.platform !== "win32") route = await ompPaneRoute(paneId);
  // an omp whose store nothing proves, or two keeping different ones
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
  // herdr names no session of this store (or another agent's): the pane's omp process does
  const held = route === null ? null : ompRouteTranscript(await ompHeldOpen(route, capabilities().agents === "reported"), cwd);
  if (held === null) throw new ConversationUnavailable("no_session_path");
  // the held transcript is the pane's own, in the store its process keeps: authorized there, and read so
  const authorized = authorizedTranscript(held, route!.layout.sessions);
  return authorized === null ? { path: held, blobs: null } : { ...ompAuthorizedTranscript(authorized), identity: authorized.identity };
}

/** The process's live API selection, lifecycle registration, or trusted report plus a unique held marker. */
async function copilotTranscriptPath(pane: HerdrPane, panes: readonly HerdrPane[], previousClaims?: ReadonlySet<string>, peerInfo?: Map<string, Awaited<ReturnType<typeof paneProcessInfo>> | null>): Promise<{ path: string; binding: string; peerClaims: ReadonlySet<string> }> {
  const report = pane.agent_session;
  // A request shares its peer snapshot across the read; the pane's own process
  // and lifecycle evidence are still validated afresh before returning history.
  // With `peerInfo`, peers' processes come from (and fill) that cache, while their
  // lifecycle logs are read again here, after this pane's own binding.
  let peerClaims: Promise<ReadonlySet<string>> | undefined = previousClaims === undefined ? undefined : Promise.resolve(previousClaims);
  // Peers are asked at once: each API read may wait out its own deadline, and they must not add up.
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
        // A peer whose API cannot answer still has its lifecycle log and report: one unreadable peer does not take Chat from this pane.
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
      // API checks yield: peers are read after this pane's selection, not from the pre-read snapshot,
      // and this pane's selection is read once more after them.
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

/** Where a pane's conversation is: a transcript file, or a session in OpenCode's database. */
type ResolvedTranscript =
  | ({ path: string; codexHome?: string; agy?: AgyStore; piAgentDir?: string | null; ompBlobs?: string | null;
    /** omp: the exact dev:ino of the file its resolver authorized (ompTranscriptPath) */
    ompFile?: string;
    /** pi: the exact dev:ino of the file its resolver authorized (piTranscriptPath) */
    piFile?: string;
    /** gjc: the exact dev:ino of the file whose header its resolver read (gjcTranscriptFileForPane) */
    gjcFile?: string;
    /** omo: the exact dev:ino of the session file its lookup read (omoSessionForPane) */
    omoFile?: string;
    /** claude: the exact dev:ino of the file whose tail its resolver read (claudeTranscriptFile, #3402) */
    claudeFile?: string;
    /** codex: the exact dev:ino of the rollout its process holds open, where its resolver proved one (#3402) */
    codexFile?: string; letta?: { store: string; agent: string; conversation: string } } & (
    | { source: Exclude<StreamSource, "copilot-transcript"> }
    | { source: "copilot-transcript"; binding: string; peerClaims: ReadonlySet<string> }
  ))
  | { source: "opencode-transcript"; path: string; session: string }
  | { source: "hermes-transcript"; path: string; sessionId: string }
  | ({ source: "dsh-transcript" } & DshTranscript)
  | ({ source: "kiro-transcript" } & KiroTranscript);

/** A native file or database session, resolved without parsing conversation turns. */
export type NativeTranscript =
  | ResolvedTranscript
  | { source: "devin-transcript"; path: string; session: string; cwd: string; binding?: string };

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
    const foreground = info?.process_info?.foreground_processes ?? [];
    const running = foreground.some((process) =>
      isGjcProcess(Array.isArray(process.argv) ? process.argv.map(String) : []),
    );
    // Preserve GJC's route even when it runs a dsh child in the same foreground group.
    if (running || await gjcPidUnderShell(info?.process_info?.shell_pid)) agent = "gjc";
    // a dsh TUI that does not report to herdr (dsh-tui-pi): its launcher in front, read from this same
    // probe, which the dsh binding then reuses; the lock that process holds still picks the session
    else if (foreground.some((process) => Array.isArray(process.argv) && isDshProcess(process.argv))) {
      agent = "dsh";
      if (known === undefined) known = (info?.process_info as KnownProcesses) ?? null;
    }
    // herdr labels Kiro from its screen: before that shows, its chat TUI in front says the same
    else if (foreground.some((process) => Array.isArray(process.argv) && isKiroChatProcess(process.argv))) {
      agent = "kiro";
      if (known === undefined) known = (info?.process_info as KnownProcesses) ?? null;
    }
    else if (await kiroCodexProcess(info?.process_info as ProcessInfo | undefined) !== null) agent = "codex";
  }
  // a Muse, Letta, dsh or Kiro pane's processes are asked for once, for omo and for its own binding
  if ((agent === "muse" || agent === "letta" || agent === "dsh" || agent === "dsh-tui" || agent === "kiro") && known === undefined) known = (await paneProcessInfo(paneId).catch(() => undefined)) ?? null;
  if (await paneRunsOmo(paneId, known)) {
    const found = await omoTranscriptPath(paneId, cwd, panes);
    return { source: "omo-transcript", path: found.path, ...(found.identity === undefined ? {} : { omoFile: found.identity }) };
  }
  // omp and GJC can change their own cwd without changing the pane's shell directory; their
  // session headers name the one they run in
  const sessionCwd = typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0 ? pane.foreground_cwd : cwd;
  try {
    // dsh-tui reports itself to herdr as `dsh-tui`; the other dsh TUIs are found by their process above
    if (agent === "dsh" || agent === "dsh-tui") return { source: "dsh-transcript", ...await resolveDshTranscript(known) };
    if (agent === "kiro") return { source: "kiro-transcript", ...await resolveKiroTranscript(known) };
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
      // the pane's own store: the rollout, its history and its images are all read from there
      const { home, placed } = await paneCodexHomePlaced(paneId, codexHome, known);
      // a store chosen while no Codex process of the pane was seen is checked against the one the lookup proves
      const proofs = new Map<string, string>();
      const path = await codexTranscriptPath(paneId, cwd, home, panes, !placed, placed && !codexHome, proofs);
      if (!path) throw new ConversationUnavailable("no_session_path");
      const codexFile = proofs.get(path);
      return { source: "codex-transcript", path, codexHome: home, ...(codexFile === undefined ? {} : { codexFile }) };
    }
    // Claude's project is the directory it started in, the process's own cwd more often than the pane's
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
    // pi's own label only routes pi: an omo pane was taken above, by its process tree.
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
    // Kimi's label, not a report an earlier agent left behind: the binding needs a process the pane owns
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

/** `identity`: the exact dev:ino of the session file omo's lookup read its header through. */
async function omoTranscriptPath(paneId: string, cwd: string, panes?: HerdrPane[]): Promise<{ path: string; identity?: string }> {
  const session = await omoSessionForPane(paneId, cwd, panes ?? (await sessionSnapshot()).panes);
  if (session.pending !== null) throw new ConversationNotStarted(session.pending);
  if (!session.path) throw new ConversationUnavailable("no_session_path");
  return { path: session.path, ...(session.identity === undefined ? {} : { identity: session.identity }) };
}

/**
 * Resolve the native live file or database session without reading conversation turns. `known`: herdr's
 * `pane.process_info` for this pane that the caller read for this same look, so it is not asked again.
 */
export async function paneTranscript(paneId: string, codexHome?: string, snapshot?: SessionSnapshot, devinDbPath?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string, known?: KnownProcesses): Promise<NativeTranscript> {
  const socket = herdrSocketPath();
  const panes = (snapshot ?? await sessionSnapshot()).panes;
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined) throw new ConversationUnavailable("pane_not_found");
  // an agent pane without a folder is a failure to diagnose, not a shell's expected scrollback
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
    // No Devin runs under the label: what does run is resolved below, as it was before this
    // reader (an omo is found by its process tree, whatever herdr calls the pane).
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

// Agy commits a step to its catalog and then to its ledger: a catalog read that fails this soon after
// a write may be racing it, and a later one is not
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
    // an agent at work on its first turn has written nothing yet, but its terminal shows the turn.
    // Claude writes its file with the first message, so at work with none it has no turn yet: a
    // /clear reports working for a moment (#2550)
    const status = snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
    if ((status === "working" && error.source !== "claude-transcript" && error.source !== "agy-transcript") || status === "blocked") throw error;
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
    if (pane.agent === "copilot") {
      // A chat that names the history it shows may wait out a rejection that says nothing of that
      // history's end, while herdr reports no other session than the one that history was read from
      const shown = copilotBindings.get(paneId);
      const reported = pane.agent_session?.value;
      const moved = copilotRecoverable(error.diagnostic) && page.history_id !== undefined
        && (shown === undefined || !page.history_id.startsWith(shown.prefix) || (reported != null && reported !== shown.session));
      const waits = page.history_id !== undefined && copilotRecoverable(error.diagnostic) && !moved;
      if ((page.before !== undefined || page.since !== undefined || page.from !== undefined) && !waits) throw new HistoryChanged();
      throw moved ? new ConversationUnavailable(error.message, error.screen, "copilot_report_mismatch", error.hint) : error;
    }
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
      if (pane.agent === "agy" && error.message === "no_session_path" && page.before === undefined && page.since === undefined && page.from === undefined && pane.agent_status !== "working" && pane.agent_status !== "blocked") {
        const fresh = await agyFreshSession(pane, await bottomViewport(paneId));
        if (fresh !== null) return await notBegun("agy-transcript", fresh);
      }
      throw error;
    }
    if (page.before !== undefined || page.since !== undefined || page.from !== undefined) throw new HistoryChanged();
    return await notBegun(launch.source, launch.historyId);
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
  // the page read below digests the transcript (transcriptGeneration): readSettled reads that off the
  // event loop first. A pane closed meanwhile (forgetPaneTranscriptState) or a herdr session left is not
  // read or recorded, and a pane bound to another transcript since is not answered (below)
  const transcript = resolved;
  const forgetsBefore = forgets;
  const live = (): boolean => herdrSocketPath() === socket && !forgottenSince(paneId, forgetsBefore);
  // set by the read below, in a closure the checker does not follow
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
    // a growth no digest checked is the same file: it is pending, with no recovery that would digest it here
    const refused = (error instanceof ConversationReadPending && !(error instanceof RevisionUnchecked)) || (error instanceof ConversationUnavailable && error.message === "transcript_missing");
    const paged = page.before !== undefined || page.since !== undefined || page.from !== undefined;
    if (resolved.source === "agy-transcript" && refused) {
      if (page.history_id === undefined && !paged) throw error;
      // a catalog that keeps failing while Agy writes nothing to it, or that is too large to ever be
      // read, is no write race: fall back (a timestamp ahead of the clock proves no recent write)
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
        } catch { /* unreadable: proves no write */ }
      }
      if (!writing || bytes > AGY_CATALOG_BYTES) throw error;
      const fresh = await sessionSnapshot().catch(() => null);
      const pane = fresh?.panes.find((candidate) => candidate.pane_id === paneId);
      if (!live() || pane === undefined) throw new ConversationUnavailable("no_session_id");
      if (!sameAgyStore(resolved.agy!, await resolveAgyStore(pane))) {
        throw paged ? new HistoryChanged() : new ConversationUnavailable("no_session_path");
      }
      let stat: Stats | undefined;
      try { stat = statSync(resolved.path, { throwIfNoEntry: false }); } catch { /* unreadable */ }
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
  // settling awaited after the transcript was resolved: a pane bound to another one since (a new session,
  // another agent) has not this answer. A pane seen bound elsewhere meanwhile is refused at once; any
  // other is resolved again (one more resolution per read), since nothing in Ovis may have looked at it,
  // and that resolution's own failure or not-begun session is the answer. Copilot's binding is checked
  // after its read below.
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
    // the file can change or go between the page and this check: either way the terminal answers
    let revision: string | null = null;
    try { revision = grokProjection(resolved.path, statSync(resolved.path)).revision; } catch { /* unreadable now */ }
    if (revision === null || revision === "0") throw new ConversationUnavailable("transcript_missing");
  }
  if (resolved.agy && !sameAgyStore(resolved.agy, await resolveAgyStore(snapshot.panes.find((pane) => pane.pane_id === paneId)!))) throw new ConversationUnavailable("no_session_path");
  if (identity !== null) { writtenSessions.add(`${resolved.source}\0${identity}`); rememberPaneSession(paneId, `${resolved.source}\0${identity}`); }
  if (resolved.source === "claude-transcript" && identity !== null && answer.metadata.context) {
    const window = readStatuslineContext(userHome(), identity, answer.metadata.model, resolved.path);
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
  if (resolved.source === "letta-transcript" && resolved.letta) {
    // Letta's transcript names no model, and /model writes no turn: its local store holds the
    // setting (lettaLocalSettings). Enrich a response, never the shared transcript page, and include
    // the setting in its ETag.
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
  // one exact stat: a file the resolver itself authorized (omp, pi, gjc, omo) is the only one read, compared whole as
  // Windows' file indexes need; omp's answer for a file it could not authorize names none, and is not read.
  // The read below is held to this stat's exact file (#3398)
  const exact = statSync(path, { bigint: true });
  const authorized = resolved.source === "omp-transcript" ? resolved.ompFile : resolved.source === "pi-transcript" ? resolved.piFile
    : resolved.source === "gjc-transcript" ? resolved.gjcFile : resolved.source === "omo-transcript" ? resolved.omoFile
    // claude and codex: checked only where the resolver proved one (a non-branch tail; a held-open rollout). A
    // branch, a screen match, or a remembered, reported or resumed rollout keeps the exact stat below (#3402)
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
export function transcriptPage(source: Exclude<StreamSource, "agy-transcript">, path: string, page: ConversationPage = {}, codexHome?: string, piAgentDir?: string | null): RecognizedConversation {
  // the files the page opens are held to the ones it began with (transcriptPageRead binds them)
  return readBound([], () => {
    if (source === "copilot-transcript") {
      let fd: number;
      try { fd = openCopilotFile(path); }
      catch (error) {
        // another file than the one the read is bound to: pending, not a missing transcript
        if (error instanceof ConversationReadPending) throw error;
        throw new ConversationUnavailable("transcript_missing");
      }
      try { return transcriptPageRead(source, path, page, codexHome, undefined, fd, piAgentDir); }
      finally { closeSync(fd); }
    }
    return transcriptPageRead(source, path, page, codexHome, undefined, undefined, piAgentDir);
  });
}

/** One page of an Agy ledger (transcriptPage), whose catalog is read on a file thread (#2706). */
export async function agyTranscriptPage(path: string, page: ConversationPage = {}, codexHome?: string, authorized?: { dev: number; ino: number }): Promise<RecognizedConversation> {
  try { return await withAgyHistory(path, (projection, fd) => ({ ...transcriptPageRead("agy-transcript", path, page, codexHome, projection, fd), activity: projection.activity }), authorized); }
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
    // a branch that cannot be walked says so; a file that went unreadable mid-read has
    // one answer, and an unreadable branch has its own; a revision left unchecked is pending
    if (error instanceof ConversationUnavailable || error instanceof ConversationReadPending) throw error;
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
  // the file's size as it was read (in `signature`): the newest page says it, an older one need not
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
      // A chat that shows older pages holds the start of its newest turns and keeps
      // every turn after it while they are inside the newest page. Once the newest
      // page has moved past it, the chat gets the newest page and fetches the turns
      // in between with `before` + `since`: no poll reads more than a page.
      if (newest !== null) {
        // a turn the window holds the start of again: a later one outgrowing it is found afresh
        if (source === "copilot-transcript") forgetCopilotTurns(path);
        start = held !== null && held >= newest.start ? held : newest.start;
        live = liveTurns(path, stream, source, start, newest.starts, piAgentDir);
        text = "";
      } else {
        // no turn starts in the window: the page begins mid-turn, read whole as before; a Copilot
        // page reaches back to its turn's start (COPILOT_PAGE_BYTES) and reads only what was appended since
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
    // another file than one the page is bound to (openBound) is pending, not a missing transcript
    if (error instanceof HistoryChanged || error instanceof ConversationUnavailable || error instanceof ConversationReadPending) throw error;
    throw new ConversationUnavailable("transcript_missing");
  }

  // the store decides the parser, not the pane's label: omo writes omp's
  // session shape while herdr may be calling that same pane `claude`. The page
  // bounds the turns, so none are cut: they must meet the next page exactly.
  // a page is parsed in stretches (before and after the newest turn start), and OmO's goal wait is
  // only ever the conversation's last word: on an older page, or anywhere but the end, it is over
  const parsed = live?.turns ?? parseTurns(source, path, text, undefined, undefined, start);
  const turns = parsed.some((turn, index) => turn.parts[0]?.kind === "goal_wait" && (page.before !== undefined || index < parsed.length - 1))
    ? parsed.filter((turn, index) => turn.parts[0]?.kind !== "goal_wait" || (page.before === undefined && index === parsed.length - 1))
    : parsed;
  const metadata = live?.metadata ?? parseConversationMetadata(`${head}\n${text}`, source, undefined, piAgentDir);
  // Record the stat from BEFORE the read: an append during parsing must cause
  // another read on the next poll, not permanently cache a torn tail.
  cache.delete(key);
  // the abandoned turns live outside the branch's byte ranges, so the page cannot see them: a
  // straight line answers { count: 0 }, which is most sessions and costs the client nothing
  const abandoned = (source === "pi-transcript" || source === "cmd-transcript") ? piAbandonedTurns(path, stat.size) ?? undefined : undefined;
  rememberPage(cache, key, { source, signature, turns, metadata, cursor, abandoned }, 32);
  return { source, turns, metadata, cursor, abandoned, history_id: stream.id, version, ...size };
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
export async function conversationImage(paneId: string, ref: string, codexHome?: string, opencodeDb?: string, grokHome?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!CLAUDE_IMAGE_REF.test(ref) && !CODEX_IMAGE_REF.test(ref) && !CODEX_TOOL_IMAGE_REF.test(ref) && !PI_IMAGE_REF.test(ref) && !PI_PROMPT_IMAGE_REF.test(ref) && !OPENCODE_IMAGE_REF.test(ref) && !GROK_IMAGE_REF.test(ref) && !COPILOT_IMAGE_REF.test(ref)) return null;
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  if (pane === undefined || typeof pane.cwd !== "string" || pane.cwd.length === 0) return null;
  let resolved: ResolvedTranscript;
  try { resolved = await resolveTranscript(pane, pane.cwd, codexHome, snapshot.panes, opencodeDb, undefined, grokHome); }
  catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
  // OpenCode's store is read per request and keeps nothing for the pane to release
  if (resolved.source === "opencode-transcript") return opencodeImage(resolved.path, resolved.session, ref);
  rememberPaneRead(paneId, resolved.path);
  if (resolved.source === "codex-transcript") {
    if (CODEX_TOOL_IMAGE_REF.test(ref)) return codexToolImage(resolved.path, ref, resolved.codexHome ?? codexHome ?? defaultCodexHome());
    return codexPromptImage(resolved.path, ref, pane.cwd, resolved.codexHome ?? codexHome);
  }
  if (resolved.source === "pi-transcript" || resolved.source === "cmd-transcript") return readAuthorized(resolved.path, () => piTranscriptImage(resolved.path, ref));
  // omo writes its pictures inline and its page reads the file in one line, as omp's does (#3420): read so, held
  // to the exact file its resolver proved where it proved one
  if (resolved.source === "omo-transcript") {
    const [dev, ino] = resolved.omoFile === undefined ? [] : resolved.omoFile.split(":").map(BigInt);
    return ompTranscriptImage(resolved.path, ref, null, "omo-transcript", dev === undefined || ino === undefined ? undefined : { dev, ino });
  }
  // the update log the pane's own Grok holds (resolveGrokStore), read only over its active history
  if (resolved.source === "grok-transcript") return grokImage(resolved.path, ref);
  // the session file the pane's own process holds (copilotTranscriptPath), opened pinned as the page reads it
  if (resolved.source === "copilot-transcript") return copilotImage(resolved.path, ref);
  // the store is held to the identity it had where the transcript was authorized (ompAuthorizedTranscript):
  // a path above it swapped since cannot move the read elsewhere
  if (resolved.source === "omp-transcript") return ompTranscriptImage(resolved.path, ref, resolved.ompBlobs ?? null);
  return resolved.source === "claude-transcript" ? transcriptImageAsync(resolved.path, ref) : null;
}

/**
 * A picture a Codex prompt holds (codexTranscriptImage), over the history the live rollout names as the
 * lookup begins: its chain is discovered with that rollout bound (another file at its path, swapped in around
 * an open, names no parent), and every rollout is then read as the file it was then. Null otherwise.
 */
export async function codexPromptImage(path: string, ref: string, cwd: string, codexHome?: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const authorized = authorizedFile(path);
  if (authorized === null) return null;
  let segments: HistorySegment[];
  try { segments = readBound([[path, authorized]], () => codexHistorySegments(path, codexHome)); } catch { return null; }
  return codexTranscriptImage(segments.map((segment) => segment.path === path ? { ...segment, identity: authorized } : segment), ref, cwd);
}

/** How much of a transcript the image endpoint reads at a time while it looks for a ref's entry. */
const IMAGE_SEARCH_WINDOW = 1024 * 1024;
/** The first stretch before a tool's result its call is looked for in (answersDrawnCallSteps). */
const CALL_SEARCH_START = 64 * 1024;

/** The short escapes JSON has for some characters inside a string. */
const JSON_SHORT_ESCAPES: Readonly<Record<string, string>> = { '"': '\\"', "\\": "\\\\", "/": "\\/", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * A pattern for `text` however JSON may write it inside a string (each character as itself, as a
 * \u escape in either case, or as its short escape), over bytes read as latin1, and the longest
 * stretch of bytes it can match.
 */
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

/**
 * Where the lines `text` is in (as JSON writes it, jsonTextPattern) lie in [from, to) of the stream,
 * found a window at a time, so a transcript is searched and never held whole. A line off the branch
 * reads blank (readStream). `head`: the first bytes from `from` on, read already (as streamBytes reads them).
 */
function* linesWithSteps(stream: TranscriptStream, text: string, from: number, to: number, head?: Buffer): Steps<[number, number][]> {
  const { pattern, span } = yield* jsonTextPatternSteps(text);
  const found: [number, number][] = [];
  let start = from;
  let hit = false;
  // the end of the line so far: text a window's edge cuts in two is still found
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
        // the piece alone, and text the window's edge cut in two (it starts in the tail, so it ends within
        // `span` characters of the piece): a long line is not copied onto the tail to be searched
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
    // the bytes known were the probe's step: the window read after them is this one's
    if (known === undefined && position + step < to) yield;
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

/** The letters JSON allows after a backslash. */
const JSON_ESCAPE_LETTERS = new Set([...'"\\/bfnrtu'].map((letter) => letter.charCodeAt(0)));
function isHexDigit(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

/**
 * A string of a record's shape whole, as JSON decodes it, decoded a window at a time; null when it
 * decodes to more than `limit` characters.
 */
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
    const text = pending + (last ? decoder.decode(yield* streamBytes(stream, position, range[1])) : decoder.decode(yield* streamBytes(stream, position, position + IMAGE_SEARCH_WINDOW), { stream: true }));
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
function* callIdSteps(stream: TranscriptStream, shape: RecordShape, id: unknown): Steps<string | null> {
  return typeof id === "string" ? yield* wholeStringSteps(stream, shape, id, PICTURE_TEXT_BYTES) : String(id ?? "");
}

/**
 * Whether a tool result before `before` would be drawn, as the parser decides it: it answers a call
 * an assistant entry the parser draws made, and no result before it answered that call already.
 * The last block before `before` that names the call decides that, so the search starts at `before`
 * and goes back a window at a time, and a call made just before its result costs that window, not
 * the transcript. False too when a record it would have to judge (one after that last block) is past
 * what the endpoint reads: then it serves nothing rather than guess.
 */
function* answersDrawnCallSteps(stream: TranscriptStream, id: string, before: number): Steps<boolean> {
  // a record before the result the endpoint may not judge refuses the forward search wherever it lies, the
  // last block naming the call or not: the search does not go back past such a record, it goes forward
  const index = pictureIndexOn ? stream.pictures : undefined;
  if (index === undefined || (index.blind !== null && index.blind < before) || unreadBefore(stream, index, before)) return yield* answersDrawnCallForwardSteps(stream, id, before);
  // a call id the parser took from a number can be written in any of a number's spellings
  const numeric = id !== "" && String(Number(id)) === id;
  let judged = 0;
  // a call is most often just before its result: the first stretch is short, and each one after twice as
  // long as the one before covered (a stretch reaches back to the start of the line it cuts)
  let span = CALL_SEARCH_START;
  // what the pieces back are read into without a lease, one buffer for the walk: a line of a MiB is not a
  // MiB allocated a piece (a lease reads into its own buffer)
  let scratch = Buffer.allocUnsafe(stream.file === undefined ? CALL_SEARCH_START : 0);
  for (let to = before, from = before; to > stream.floor; span = Math.min(IMAGE_SEARCH_WINDOW, Math.max(span, to - from) * 2), to = from, yield) {
    // the lines that end in the last `span` bytes before `to`, whole: back from `to - span`, a piece at a
    // time, to the start of the line it falls in, so the walk costs about what that line has before it
    from = Math.max(stream.floor, to - span);
    // what the piece that found the line's start holds of it: the window is not read again for those bytes
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
      // the walk's buffer: the window takes these bytes in before the next piece is read into it. A lease's
      // bytes are copied: they hold only until its next read, and a numeric id searches the lines twice
      if (newline !== -1) head = stream.file === undefined ? bytes.subarray(newline + 1) : Buffer.from(bytes.subarray(newline + 1));
      // each read is a step of its own: what reads the lines it found starts on the next one
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

/** answersDrawnCallSteps as a search forward from the floor: every record before `before` that names the call is judged. */
function* answersDrawnCallForwardSteps(stream: TranscriptStream, id: string, before: number): Steps<boolean> {
  const ranges = yield* linesWithSteps(stream, id, stream.floor, before);
  // a call id the parser took from a number can be written in any of a number's spellings
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
 * The image an image part's ref names in a Claude transcript file, decoded; null when there is none,
 * or when it is no picture the page would name (claudeImageType: the same check, so they agree). It
 * is read as the page is: after the last /clear, on the branch a rewind left the session on, and a
 * tool's picture only from a result the page draws. It holds a window, a record's shape and the
 * picture's own bytes at a time, never a record or the transcript whole.
 */
type TranscriptPicture = { mediaType: string; bytes: Uint8Array<ArrayBuffer> };

/** The synchronous reader remains available to page consumers and tests. */
export function transcriptImage(path: string, ref: string): TranscriptPicture | null {
  try { return finish(transcriptImageSteps(path, ref, false)); } catch { return null; }
}

/**
 * On the shared reader (transcriptReader): the transcript's bytes and stats come by async positional
 * reads of the file it pinned, so a slow disk holds up no other request, and the event loop gets its
 * turn between windows and short records too. The lookups of one transcript take it in turn (imageTurn).
 * The path is checked by the file it names (`follow`), a link to the transcript too, as statSync does.
 */
export async function transcriptImageAsync(path: string, ref: string): Promise<TranscriptPicture | null> {
  // The lookup began when it was asked for, not when its turn came (TranscriptStream.version): the
  // pictures of a page are asked for together and take their turns one after another, and a check of
  // the index's bytes (vouchedPictureSteps) that one of them makes vouches for the others, which began
  // before it, as it does for lookups made side by side. A lookup only takes a verdict from a check
  // begun after it was asked for, so that verdict is what the file held at a moment between the
  // request and its answer. The version itself is still the lease's: a rewrite between that check and
  // this lookup's stat changes it, unless the file's times did not move (the limit fineTimes states).
  const began = { began: performance.now(), wall: Date.now() };
  // the file the lease pins is the one the path names as the lookup begins, not one put there while it waited its turn
  const authorized = authorizedFile(path);
  if (authorized === null) return null;
  try { return await imageTurn(path, () => transcriptReader.read(path, (file) => finishAsync(boundSteps([[path, authorized]], transcriptImageSteps(path, ref, true, file, began))), { follow: true })); } catch { return null; }
}

/**
 * The reader leases a path to one read at a time anyway: a page's pictures of one transcript wait
 * here, one after another, so together they hold one place in its bounded queue (never refused for
 * it), and each after the first finds the boundary the first one kept.
 */
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
  // a lease (`file`) pins the file itself
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
  // A failed lookup may have published a boundary before a later read or filesystem fence throws.
  const unpublish = (...streams: TranscriptStream[]): null => {
    const kept = clearScans.get(path);
    if (kept !== undefined && (streams.some((scanned) => scanned.published?.scan === kept && scanned.published.through === kept.scanned) || (kept === boundary && boundary.scanned === boundaryScanned))) clearScans.delete(path);
    return null;
  };
  try {
    const stat = yield* pinned();
    // another file than the one the lookup is bound to (transcriptImageAsync) holds none of its pictures
    checkBoundFile(path, stat);
    const current = function* (snapshot: Stats): Steps<boolean> { return sameImageFile(snapshot, yield* pinned()) && (yield* named(snapshot)); };
    // a lease is let in only while the path names the file it pinned (TranscriptReader.read); a change
    // since is judged once the read ends, as one during it is
    if (file === undefined && !(yield* current(stat))) return null;
    const stream = transcriptStream("claude-transcript", path, stat, defaultCodexHome(), undefined, fd, file !== undefined);
    stream.file = file;
    // a lookup asked for before its turn began then (transcriptImageAsync)
    if (began !== undefined && stream.version !== undefined) stream.version = { ...stream.version, ...began };
    scans.push(stream);
    stream.current = () => current(stat);
    if (apart) stream.seen = { from: 0, digest: 0n };
    // a read rejected after its scan published a boundary takes that boundary back (unless a newer read replaced it):
    // it was built from bytes that no longer stand, and a later lookup must not reuse it as an append's prefix
    yield* applyHistoryBoundarySteps(path, stream, "claude-transcript", apart);
    const picture = yield* claudePictureSteps(stream, match, apart);
    // the file held still for the whole read (its size, times and identity, by the pinned fd and by path)
    if (!apart || (yield* current(stat))) return picture;
    // a boundary kept from before the change is checked only by its tail, which a rewrite can keep
    if (picture === null) return unpublish(stream);
    // It changed under the read: only an append can keep the picture, and what was read may since be gone
    // (a rewrite, then its undoing: ABA). So the read is made again on what the file holds now, from a
    // boundary rebuilt from those bytes (a rewrite before an append keeps the tail a kept boundary is
    // checked by), and what that read finds is served.
    const now = yield* pinned();
    if (now.dev !== stat.dev || now.ino !== stat.ino || now.size <= stat.size || !(yield* named(now))) return unpublish(stream);
    // the bytes the boundary scan read (all of them on a cold read, the tail since the last one on a warm
    // read) must still be there: a rewrite of what this read saw is no append, whatever it changed
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
    // a further change during this read is retried by a later request
    return again !== null && (yield* current(now)) ? again : unpublish(stream, active);
  } catch { return unpublish(...scans); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Lets a test look a picture up as the search alone does, the reference the index is held to (false), or with the index again. */
let pictureIndexOn = true;
export function pictureIndexForTests(on: boolean): void {
  pictureIndexOn = on;
}

/** Whether a record the endpoint may not judge (PictureIndex.unread) lies on the branch between the floor and `before`. */
function unreadBefore(stream: TranscriptStream, index: PictureIndex, before: number): boolean {
  return index.unread.some(([start, end]) => start >= stream.floor && start < before && !stream.hidden?.some(([low, high]) => low <= end && start < high));
}

/**
 * The record the boundary scan indexed for `uuid` (PictureIndex), when it is still the first one the
 * search from the floor would judge: past the floor, within the stream, on the session's branch, and
 * with no record before it the search could refuse at.
 */
function indexedPicture(stream: TranscriptStream, uuid: string): IndexedPicture | undefined {
  const index = pictureIndexOn ? stream.pictures : undefined;
  const record = index?.at.get(uuid);
  if (record === undefined || record.start < stream.floor || record.end >= stream.length) return undefined;
  if (stream.hidden?.some(([start, end]) => start <= record.end && record.start < end)) return undefined;
  return unreadBefore(stream, index!, record.start) ? undefined : record;
}

/**
 * Stops using an index found out of date, in the scan that keeps it too, until a /clear starts another
 * (applyHistoryBoundarySteps): no record is taken from it, and a call is looked for forward.
 */
function forgetPictures(index: PictureIndex): void {
  index.at.clear();
  index.blind = 0;
}

/** the record judged is not the one the picture is in: the search goes on (pictureInRecordSteps) */
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
/**
 * A read that checks an index's bytes (vouchedPictureSteps), by the file version it checks: the lookups
 * of that version that began before it share it, and none that began after it (that lookup's own version
 * may name bytes rewritten since the read took them, its times kept)
 */
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
 * that uuid, or one the endpoint cannot judge: the search would decide otherwise. A version an earlier
 * read vouched for (PICTURE_RACY_MS) is trusted; any other is read once, from where the index starts to
 * where the scan read, and the lookups of that version that began before the read share it (PictureCheck). Bytes
 * that do not match turn the index off (forgetPictures). `apart`: a cooperative lookup, which can wait for
 * another's read.
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

/** Whether the file still holds the bytes `bytes` digests, read as the scan read them (raw, every range). */
function* pictureBytesStandSteps(stream: TranscriptStream, bytes: PictureBytes): Steps<boolean> {
  if (bytes.through > stream.length) return false;
  const raw = { ...stream, hidden: undefined };
  let digest = 0n;
  for (let at = bytes.from; at < bytes.hashed;) {
    // whole digest pieces in each read: IMAGE_SEARCH_WINDOW is a multiple of PICTURE_DIGEST_BYTES
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
  // the boundary scan's last read was a step's: the record's read is the next one's
  yield;
  const uuid = match[1]!;
  const index = pictureIndexOn ? stream.pictures : undefined;
  // A picture the index holds no record of would use it only for the call search, which goes back by what
  // it noted (unread, blind): that stands only for bytes a read vouched for. When none has for this
  // version, the lookup is the search alone, as with the index off, rather than a read of the bytes on top
  // of it, and it neither vouches for nor forgets the index.
  if (index !== undefined && indexedPicture(stream, uuid) === undefined && !vouchedFor(index, stream.version)) stream = { ...stream, pictures: undefined };
  else yield* vouchedPictureSteps(stream, apart);
  const indexed = indexedPicture(stream, uuid);
  // The index is trusted only while the bytes it was built from stand (vouchedPictureSteps), its record
  // among them. A record that is not the picture's after all leaves it to the search all the same.
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

/** The picture `match` names, judged in the record at `range` as the search judges each record it finds. */
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
/** A whole output is still bounded: a page of it, not a log file. */
const TOOL_OUTPUT_MAX = 2_000_000;

/** The whole output of a tool call whose page output was cut, by its id; null when there is none. */
export async function toolOutput(paneId: string, ref: string, codexHome?: string, opencodeDb?: string, hermesHome?: string, grokHome?: string, museData?: string): Promise<string | null> {
  if (!TOOL_REF.test(ref) && !/^cp[0-9a-f]{16}\.[A-Za-z0-9_:.-]{1,128}(?:@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32})?$/.test(ref)) return null;
  // a pane closed (forgetPaneTranscriptState) or a herdr session left while this awaited answers nothing
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
    // Agy's and Letta's are read below, off this lookup
    return transcript.source === "agy-transcript" || transcript.source === "letta-transcript" ? null
      : transcriptToolOutput(transcript.source, transcript.path, nativeRef, transcript.codexHome ?? codexHome);
  };
  let output: string | null;
  // the sources whose lookup digests the transcript (transcriptGeneration) read that off the event loop first
  if (resolved.source === "copilot-transcript" || resolved.source === "omo-transcript") {
    let settled: { value: string | null } | null;
    // a transcript the path no longer names (replaced while it settled) has not this output
    try { settled = await readSettled({ path: resolved.path, checkWindow: false, live }, lookup); }
    catch (error) { if (error instanceof ConversationUnavailable || error instanceof ConversationReadPending) return null; throw error; }
    // a pane bound to another transcript while this settled (another OmO session) has not this output:
    // one seen bound elsewhere is refused at once, any other resolved again. Copilot's is checked below.
    if (settled === null || rebound(paneId, transcript)) return null;
    if (transcript.source === "omo-transcript") {
      let fresh: NativeTranscript;
      try { fresh = await paneTranscript(paneId, codexHome, undefined, undefined, opencodeDb, hermesHome, grokHome, museData); }
      catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
      if (fresh.source !== transcript.source || fresh.path !== transcript.path) return null;
    }
    output = settled.value;
  } else if (resolved.source === "pi-transcript" || resolved.source === "cmd-transcript" || resolved.source === "codex-transcript") {
    output = readAuthorized(resolved.path, lookup);
  } else if (resolved.source === "letta-transcript") {
    // scanned on a file thread, which reads only the file the path names as the lookup begins: one long line
    // took this thread, which answers every other request and terminal, for seconds (#3326). A ref in
    // another agent's shape (Copilot's) names no call of Letta's
    const authorized = TOOL_REF.test(ref) ? authorizedFile(resolved.path) : null;
    output = authorized === null ? null : await lettaToolOutputOffThread(resolved.path, ref, authorized, TOOL_OUTPUT_MAX);
    if (output !== null) {
      // a pane bound to another conversation while its transcript was scanned (`/new`, another letta started
      // in it) has not this output: one seen bound elsewhere is refused at once, any other resolved again
      if (rebound(paneId, transcript)) return null;
      let fresh: NativeTranscript;
      try { fresh = await paneTranscript(paneId, codexHome, undefined, undefined, opencodeDb, hermesHome, grokHome, museData); }
      catch (error) { if (error instanceof ConversationUnavailable) return null; throw error; }
      if (fresh.source !== transcript.source || fresh.path !== transcript.path) return null;
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

/**
 * The output a transcript file holds for one tool call id, whole (up to TOOL_OUTPUT_MAX). Agy's and Letta's
 * are not read here: toolOutput awaits theirs (agyToolOutput, lettaToolOutputOffThread).
 */
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
      // A window may start inside a record; never interpret that partial record.
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
  // read whole through one open held to the file the path names as the lookup begins (readAuthorized)
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
function* ompTranscriptImageSteps(path: string, ref: string, given: string | null | undefined, source: "omp-transcript" | "omo-transcript"): Steps<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const tool = PI_IMAGE_REF.exec(ref);
  const match = tool ?? PI_PROMPT_IMAGE_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const [, id, nth] = match;
  // omo keeps every picture inline: no store to read a blob from
  const blobs = source === "omp-transcript" ? ompBlobStore(path) : null;
  const anchor = blobs === null ? null : given === undefined ? ompBlobAnchor(blobs)?.identity ?? null : given;
  {
    const stream = transcriptStream(source, path, statSync(path), defaultCodexHome());
    yield* applyHistoryBoundarySteps(path, stream, source, true);
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
      if (isContextClear(entry, source)) { open = false; found = null; continue; }
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
  // as ompTranscriptImage: the live rollout as the lookup begins, and each earlier one as the chain is laid out (transcriptStream)
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
