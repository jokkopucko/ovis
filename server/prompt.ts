import { createHash, randomBytes } from "node:crypto";
import type { HerdrPane, InteractivePrompt, PanePromptResponse, PromptAnswer, SessionSnapshot, SlashCommand } from "../shared/protocol.ts";
import { labelledAgent } from "../shared/supported-agents.ts";
import { builtinCommands, cachedPaneCommands } from "./commands.ts";
import { piRecordText } from "./pi-delivery.ts";
import { agentProcesses, ompTranscriptPath, paneRunsOmo, readCommandTranscript } from "./conversation.ts";
import { ConversationNotStarted } from "./conversation-shared.ts";
import { agentProcessInFront } from "./agent-process.ts";
import { resolveAgent } from "./pane-context.ts";
import { processAlive, processStartedAt, processStartUpperBoundAsync } from "./process-start.ts";
import { commandInvocations, commandOutcome, CommandReservations, dialogSettlingScreen, ownsCommandDialog, WINDOW_MS as COMMAND_WINDOW_MS, type CommandSend } from "./outcome.ts";
import { codexTranscriptPath, paneCodexHomePlaced, unansweredCodexQuestions } from "./codex.ts";
import { HerdrError, paneGet, paneProcessInfo, paneRead, paneScrollInfo, paneSendKeys, paneSendText, type ProcessInfo } from "./herdr/client.ts";
import { isPiProcess, piTranscriptPath } from "./pi.ts";
import { heldOmoProcess } from "./omo.ts";
import { OmoAskReader, ompAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { ompCallPrompt, ompMarkdownPrompt, ompOpenCall, ompStepPrompt } from "./omp-ask.ts";
import { gjcCallStillOpen, gjcCallStillOpenInFile, withGjcFallback } from "./gjc-ask.ts";
import { answerPiAskUser, bindPiAsk, piAskActivity, piAskUserPrompt } from "./pi-ask-bridge.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";
import { claudePlanFile } from "./claude-plan.ts";
import { heldBody, type ApprovalDialog, type ApprovalHub, type CommandEvent } from "./approvals/hub.ts";
import { acpPrompt, answerAcpPrompt, type AcpCards } from "./approvals/acp.ts";
import { listPendingPermissions, listPendingQuestionForms, openCodePermissionsRead, openCodeService, replyOpenCodeForm, replyOpenCodePermission, withShellInput } from "./opencode-service.ts";
import { opencodeSessionId } from "./opencode.ts";
import { agentPickerWaits, registry, SCREEN_READ_AGENTS } from "./dialogs/registry.ts";
import { ANSI_RE, type AnswerStep, KEY, type OmoAsk, type ParsedPrompt, type PromptDraft, cleanLine, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, own, parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { executeInteractionPlan } from "./dialogs/interaction-plan.ts";
import { liveScreen, parsePrompt, promptTailIsActive } from "./dialogs/live.ts";
import { LETTA_SEARCH_MAX, lettaPick, lettaSearchShown } from "./dialogs/letta.ts";
import { agyCustomEditorMatches, agySameQuestion, parseAgyQuestion } from "./dialogs/agy.ts";
import { dshFreeTextRow, dshTypedText } from "./dialogs/dsh.ts";
import { sameText } from "./dialogs/omo.ts";
import { OMP_REVIEW_HINT_RE, OMP_TABS_HINT_RE, ompCustomEditorMatches } from "./dialogs/omp.ts";
import { openCodePermissionPrompt, openCodeV1CustomEditorMatches } from "./dialogs/opencode.ts";
import { INVISIBLE_CHAR_RE } from "./dialogs/claude.ts";
import { parsePiDialog } from "./dialogs/pi.ts";
import { pendingPiQuestionnaires } from "./pi-questionnaire.ts";
import { isPiQuestionnaireScreen, parsePiQuestionnaire, piQuestionnaireInputMatches, piQuestionnaireOf } from "./dialogs/pi-questionnaire.ts";
import { parsePiAsk } from "./dialogs/pi-ask.ts";
import { navigatePiAsk } from "./dialogs/pi-ask-navigate.ts";
import { draftKept, nativeStepTarget, navigateNativeSteps } from "./dialogs/step-navigate.ts";
import { gjcCustomEditorMatches, parseFallbackPrompt } from "./dialogs/fallback.ts";
import { withRecord } from "./dialogs/record.ts";
import { isHermesInstalledLauncher, titleStatus } from "./agent-identity.ts";
import { recordFor, recordRequest, recordSettled, type RecordOutcome, withAgentRecord } from "./record-cards.ts";
import { answerServed, questionClosed, withServedAsk } from "./codex-question.ts";
import { SUGGESTION_READ_MS, claudeHeldIsGrey, claudeInputBoxContent, claudeInputDraft, claudeRestoredDraft, parseClaudeSuggestion, viewportShowsLive } from "./claude-input.ts";
import { parseGjcSuggestion, parseOmpSuggestion } from "./omp-input.ts";
import { OMO_FORM_RE, omoAskOf, omoAsksFor } from "./omo-questions.ts";
import { codexQueuedPrompt, queuedQuestionCount, type QueueFront } from "./codex-queue.ts";
import { OpenCodePromptState } from "./opencode-prompt.ts";
export { removedInvisible } from "./dialogs/claude.ts";
export type { OmoAsk } from "./dialogs/shared.ts";
export { parseFallbackPrompt } from "./dialogs/fallback.ts";
export { CLAUDE_CLEAR_INPUT_KEYS, INPUT_BOX_SHOWN_CHARS, claudeBoxRows, claudeClearableDraft, claudeHeldIsGrey, claudeInputBoxContent, claudeSendAnywayBox, claudeInputBoxText, foldedPlaceholder, claudeInputDraft, claudeInputEmpty, claudeRestoredDraft, claudeRewindOpen, historyEndShowsLive, isClaudeHeld, parseClaudeSuggestion, shownInputBox, viewportShowsLive } from "./claude-input.ts";
export { hermesInputDraft } from "./hermes-input.ts";
export { OpenCodePromptState } from "./opencode-prompt.ts";
export { openOmoAsks, pendingOmoAsk } from "./omo-questions.ts";
export { codexQueuedPrompt } from "./codex-queue.ts";

const heldCandidates = new Map<string, { text: string; at: number }>();
const HELD_WINDOW_MS = 10 * 60_000;
type PaneCommandSend = CommandSend & {
  store: string | null;
  visibility?: {
    readonly terminalId: string;
    discovering: boolean;
    identity: string;
    process?: { readonly pid: number; readonly started: number | null; readonly held?: true } | null;
    /**
     * No foreground process matched the agent when binding (native Windows lists only the shell; an executable
     * named otherwise than its kind), or the read failed: nothing can show a replacement, so the session the same
     * agent reports in this terminal is adopted.
     */
    unmatched?: true;
    /**
     * The agent herdr named for the pane when the send was made: herdr names an OmO pane `pi`, and a session it
     * reports there is labelled so, never `omo`. An unmatched send adopts a session under this label too.
     */
    readonly label?: string | null;
    /**
     * The identity herdr still reported from an earlier process when this send went to a later one (a restarted
     * Claude Code keeps its old session id until its first turn): the send waits for its own session, as one sent
     * before any session does, and is never adopted into this one; only within STALE_SESSION_LAG_MS, and not past a
     * later Chat session change.
     */
    stale?: string;
    binding?: Promise<void>;
    misses?: number;
    replaced?: true;
  };
  sessionChange?: { readonly terminalId: string; identity?: string };
};
/** What the chat last sent to each pane: Claude Code puts that text back in its input box when the send is cancelled right after it. */
const chatSent = new Map<string, { text: string; commands: PaneCommandSend[]; reservations: CommandReservations }>();

const outcomeIdentity = (pane: HerdrPane): string => JSON.stringify([pane.terminal_id, pane.agent_session]);

/**
 * The agent process in front (agentProcessInFront, as a pending send is bound), keyed by its pid and, on Linux, its
 * start time; never the process-group id. `held`: the OmO process holding a session (heldOmoProcess), which an
 * argv-silent custom OmO is known by alone, so a send is not bound to its bundled SDK child; a process bound so is
 * marked `held` and keyed by its start on macOS too (the kernel's record, no `ps`). With `bound`, that process only,
 * while herdr still lists it as one of the agent's, or it is the OmO it was bound as: a holder counts only while its
 * start is readable (never on Windows, which hands a finished agent's pid to the next process at once), and a later
 * start under that pid is another process (checkBoundProcess).
 */
function outcomeProcess(info: ProcessInfo | undefined, agent: string, bound?: number, held?: number | null):
  { pid: number; started: number | null; held?: true } | null {
  const running = agentProcessInFront(info, agent, bound, held);
  if (!running) return null;
  const heldStart = running.pid === held ? processStartedAt(running.pid) : null;
  if (bound !== undefined && (running.pid !== bound || heldStart === null && agentProcesses([running], agent).length === 0)) return null;
  return heldStart !== null ? { pid: running.pid, started: heldStart, held: true }
    : { pid: running.pid, started: process.platform === "linux" ? processStartedAt(running.pid) : null };
}

const heldOmoOf = async (pane: HerdrPane | null | undefined, agent: string, info: ProcessInfo | undefined): Promise<{ pid: number; started: number | null } | null> =>
  pane && agent === "omo" ? await heldOmoProcess(pane, info?.foreground_processes ?? []).catch(() => null) : null;

/**
 * outcomeProcess for a send, the OmO holder keyed by the start its holder check verified: a pid reused between that
 * check and this read is another process, which the next poll tells apart (checkBoundProcess), never the holder (#2190).
 */
function sentToProcess(info: ProcessInfo | undefined, agent: string, held: { pid: number; started: number | null } | null): { pid: number; started: number | null; held?: true } | null {
  const found = outcomeProcess(info, agent, undefined, held?.pid ?? null);
  return found?.held && held ? { ...found, started: held.started } : found;
}

const BINDING_WAIT_MS = 250;

/**
 * How long after a send herdr may still report the session of the process before a restart: a restarted Claude Code
 * keeps the old id until its first turn, seen live for 20 s (F2 r3) and for at least 45 s (todo 42's probe). A send
 * waiting for its own session (`stale`) adopts the next one only this long; after that it stays with the session it
 * was made in, like any other send, so a resumed session (claude -c, codex resume) that truly kept its id does not
 * carry its rows into a later one for long.
 */
const STALE_SESSION_LAG_MS = 60_000;

const sameProcess = (a: { pid: number; started: number | null }, b: { pid: number; started: number | null }): boolean =>
  a.pid === b.pid && (a.started === null || b.started === null || a.started === b.started);

/**
 * Records which agent process a send went to, so its row follows that process (commandOutcomes), also when no browser
 * polls until after a replacement. Every send is bound, not only one made before the session is known: herdr can keep
 * reporting a restarted Claude Code's old session id until its first turn, so the session alone would keep the old
 * process's rows. Recording never holds delivery: nothing here is awaited.
 * `seen`: herdr's foreground answer read before this send, which is the process it went to. Without one, the read
 * starts alongside delivery and can answer after a replacement: a process that started at or after the send never
 * received it, so the send is left unidentified rather than bound to it. Outside Linux and macOS no start time is
 * known and the answer is taken as the send-time one. `pane`: the pane the send went to, which places an OmO's
 * session holder (heldOmoProcess). `held`: that holder as the caller already checked it (a queued send's pending
 * context), or null when its process is no holder: then no holder is read again, so two holders listed in another
 * order meanwhile cannot move the send to the other one (#2190).
 */
export function bindCommandProcess(paneId: string, command: PaneCommandSend | undefined, seen?: ProcessInfo, pane?: HerdrPane | null,
  held?: { pid: number; started: number | null } | null): void {
  const visibility = command?.visibility;
  if (!command || !visibility || visibility.process !== undefined || visibility.binding) return;
  const sentAt = Date.now();
  visibility.binding = (async () => {
    if (seen) {
      await Promise.resolve();
      visibility.process = sentToProcess(seen, command.agent, held !== undefined ? held : await heldOmoOf(pane, command.agent, seen));
      if (!visibility.process) visibility.unmatched = true;
      return;
    }
    const info = await paneProcessInfo(paneId).catch(() => undefined);
    const found = sentToProcess(info, command.agent, held !== undefined ? held : await heldOmoOf(pane, command.agent, info));
    const startedBy = found ? await processStartUpperBoundAsync(found.pid) : null;
    visibility.process = found && (startedBy === null || startedBy < sentAt) ? found : null;
    if (!found) visibility.unmatched = true;
  })().finally(() => { visibility.binding = undefined; });
}

function checkBoundProcess(visibility: NonNullable<PaneCommandSend["visibility"]>, agent: string, processes: ProcessInfo):
  { pid: number; started: number | null } | null {
  const original = visibility.process!;
  const current = outcomeProcess(processes, agent, original.pid, original.held ? original.pid : null);
  if (current) {
    visibility.misses = 0;
    if (original.started !== null && current.started !== null && original.started !== current.started) visibility.replaced = true;
    return current;
  }
  // Out of the foreground is not gone: a suspended agent (Ctrl+Z) or another process group holding the
  // terminal is still the same process. On Linux /proc says whether the pid is gone, or reused under another
  // start time. Elsewhere a gone pid is proof; a live one is the same process on macOS and the other Unixes,
  // which hand a pid out again only after the whole range, but not on Windows, which reuses a finished
  // process's number at once. Where none of that can say, two looks in a row without the process say so.
  if (process.platform === "linux") {
    const started = processStartedAt(original.pid);
    if (started === null || original.started !== null && started !== original.started) visibility.replaced = true;
    else if (original.started === null && (visibility.misses = (visibility.misses ?? 0) + 1) >= 2) visibility.replaced = true;
    return null;
  }
  const alive = processAlive(original.pid);
  if (!alive) visibility.replaced = true;
  else if (process.platform === "win32" && (visibility.misses = (visibility.misses ?? 0) + 1) >= 2) visibility.replaced = true;
  return null;
}

export function prepareCommandSend(pane: HerdrPane, text: string, screen = ""): PaneCommandSend | undefined {
  if (!/(?:^|\s)[/$@]\S/u.test(text)) return undefined;
  const cached = cachedPaneCommands(pane);
  const agent = cached?.agent ?? resolveAgent(pane).agent;
  if (!agent) return undefined;
  return commandSendFrom(pane, agent, cached?.commands ?? builtinCommands(agent), text, screen);
}

/**
 * Whether Pi runs `text` as something it keeps no record of as sent, read as Pi's submit handler reads
 * the trimmed text: a builtin such as `/model` runs without a user record, and `!command` is recorded
 * as the shell's output. So no record can ever confirm a Chat receipt for it. A builtin's name with an
 * argument it does not take (`/new please`) and a lone `!` are messages Pi records as typed, matched
 * as Pi matches them (case and all). Any other `/name` keeps its receipt: whether it is a prompt
 * template or an extension's command depends on what that Pi loaded, which no catalog proves, and
 * pi-delivery.ts settles it on the first record Pi writes after it. A skill is read back from its record.
 */
export function piRunsCommand(pane: HerdrPane, text: string): boolean {
  const typed = piRecordText(text);
  if (typed.startsWith("!")) return (typed.startsWith("!!") ? typed.slice(2) : typed.slice(1)).trim().length > 0;
  const name = /^\/(\S+)(?:\s|$)/u.exec(typed)?.[1];
  if (!name) return false;
  const cached = cachedPaneCommands(pane);
  const commands = cached?.agent === "pi" ? cached.commands : builtinCommands("pi");
  return commands.some((row) => {
    if (row.trigger !== undefined || row.source !== "builtin" || row.name !== name) return false;
    if (typed === `/${name}`) return true;
    return typed.startsWith(`/${name} `) && (row.forms ?? []).some((form) => form.match !== "bare");
  });
}

/** A hint only: what that Pi loaded may differ, so the receipt stays (pi-delivery.ts settles it on the first record after it). */
export function piListsTemplate(pane: HerdrPane, text: string): boolean {
  const name = /^\/(\S+)(?:\s|$)/u.exec(piRecordText(text))?.[1];
  const cached = cachedPaneCommands(pane);
  return name !== undefined && cached?.agent === "pi" && cached.commands.some((row) =>
    row.trigger === undefined && row.source !== "builtin" && row.source !== "skill" && row.name === name);
}

export function commandSendFrom(pane: HerdrPane, agent: string, commands: SlashCommand[], text: string, screen = ""): PaneCommandSend | undefined {
  const invocations = commandInvocations(agent, text, commands);
  if (invocations.length === 0) return undefined;
  const sessionChange = /^\/(?:clear|new|reset|resume)(?:\s|$)/iu.test(text.trim())
    && commands.some((row) => row.source === "builtin" && row.name === invocations[0]?.name);
  return { id: randomBytes(12).toString("hex"), text, at: Date.now(), agent, identity: outcomeIdentity(pane),
    visibility: { terminalId: pane.terminal_id, discovering: pane.agent_session == null, identity: outcomeIdentity(pane), label: pane.agent },
    screen, invocations, form: invocations[0]?.form ?? null, store: null,
    ...(sessionChange ? { sessionChange: { terminalId: pane.terminal_id } } : {}) };
}

type SubmittedListener = (paneId: string, prompt: boolean, sentAt: number | undefined) => void;
const submittedListeners = new Set<SubmittedListener>();

/**
 * `prompt`: it is a prompt, which begins a turn; a slash command may run with none, and Claude Code may hold a
 * message with invisible characters.
 */
export function onChatSubmitted(listener: SubmittedListener): () => void {
  submittedListeners.add(listener);
  return () => { submittedListeners.delete(listener); };
}

/** A message the chat just sent to a pane: one with invisible characters may be held by Claude Code. */
export function noteSubmitted(paneId: string, text: string, command?: PaneCommandSend, sentAt?: number): void {
  const previous = chatSent.get(paneId)?.commands ?? [];
  const reservations = chatSent.get(paneId)?.reservations ?? new CommandReservations();
  reservations.close(command?.text ?? text, command?.at ?? Date.now());
  if (command) reservations.add(command, registry.readersFor(command.agent));
  const commands = command ? [...previous, command].slice(-5) : previous;
  chatSent.delete(paneId);
  chatSent.set(paneId, { text, commands, reservations });
  if (chatSent.size > 128) chatSent.delete(chatSent.keys().next().value!);
  if (command) heardBefore(paneId, command);
  if (INVISIBLE_CHAR_RE.test(text)) heldCandidates.set(paneId, { text, at: Date.now() });
  else heldCandidates.delete(paneId);
  const prompt = !INVISIBLE_CHAR_RE.test(text) && !text.trimStart().startsWith("/");
  // the message is sent: what a listener makes of it must not turn the send into a failure
  for (const listener of submittedListeners) {
    try { listener(paneId, prompt, sentAt); } catch (error) { console.error(`chat send on ${paneId}: a listener failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

export function lastChatSubmitted(paneId: string): string | null {
  return chatSent.get(paneId)?.text ?? null;
}

export function noteCommandEvidence(paneId: string, id: string, evidence: NonNullable<Parameters<typeof commandOutcome>[2]["evidence"]>): void {
  const commands = chatSent.get(paneId)?.commands ?? [];
  const index = commands.findIndex((sent) => sent.id === id);
  const sent = commands[index];
  if (!sent) return;
  sent.outcome = commandOutcome(paneId, sent, { now: Date.now(), evidence, nextAt: commands[index + 1]?.at });
}

/** What a hook told of a command it ran that no send matched yet: the send is noted once herdr has taken its keys. */
type HeardCommand = CommandEvent & { agent: string; at: number };
const hookHeard = new Map<string, HeardCommand[]>();
const HOOK_HEARD_MAX = 8;
const HOOK_HEARD_MS = 30_000;

/**
 * Whether the command a hook told of at `at` is `sent`: to the same agent, after it was sent and within its window, from
 * the process it was sent to, the same command (the builtin `/clear`, `/new` and `/reset` all start the next session as a
 * clear; a skill named clear is not one) with the same argument where the hook names it.
 */
function hookRan(sent: PaneCommandSend, agent: string, { name, builtin, args }: CommandEvent, at: number): boolean {
  if (sent.agent !== agent || at <= sent.at || at >= sent.at + COMMAND_WINDOW_MS || sent.outcome?.state === "result-observed"
    || sent.visibility?.replaced) return false;
  const invocation = sent.invocations[0];
  if (invocation === undefined) return false;
  if (builtin && name === "clear") return sent.sessionChange !== undefined && invocation.name !== "resume";
  return sent.sessionChange === undefined && invocation.name === name && (args === undefined || invocation.argument.trim() === args.trim());
}

/**
 * A command the agent's own hook said it ran (server/approvals/hub.ts): the result of the oldest open send of it, even
 * when another send followed it (a `/compact` takes a while). One told before the send is noted (herdr answers the keys
 * after the agent has them) waits a while for it.
 */
export function noteHookCommand(paneId: string, agent: string, command: CommandEvent, at = Date.now()): void {
  const sent = (chatSent.get(paneId)?.commands ?? []).find((sent) => hookRan(sent, agent, command, at));
  if (sent) return noteCommandEvidence(paneId, sent.id, { kind: "native", at, named: true });
  const heard = (hookHeard.get(paneId) ?? []).filter((entry) => at - entry.at < HOOK_HEARD_MS);
  heard.push({ ...command, agent, at });
  hookHeard.delete(paneId);
  hookHeard.set(paneId, heard.slice(-HOOK_HEARD_MAX));
  if (hookHeard.size > 128) hookHeard.delete(hookHeard.keys().next().value!);
}

/** A hook that told of `sent` before it was noted. */
function heardBefore(paneId: string, sent: PaneCommandSend): void {
  const heard = hookHeard.get(paneId) ?? [];
  const index = heard.findIndex((entry) => hookRan(sent, entry.agent, entry, entry.at));
  if (index < 0) return;
  const [entry] = heard.splice(index, 1);
  noteCommandEvidence(paneId, sent.id, { kind: "native", at: entry!.at, named: true });
}

async function commandOutcomes(paneId: string, pane: HerdrPane, prompt: InteractivePrompt | null, screen: string | undefined, readSendId: string | undefined, codexHome?: string, snapshot?: SessionSnapshot): Promise<NonNullable<PanePromptResponse["outcomes"]>> {
  if (!chatSent.get(paneId)?.commands.length) return [];
  chatSent.get(paneId)?.reservations.prune(Date.now());
  screen ??= await liveScreen(paneId).catch(() => "");
  const commands = chatSent.get(paneId)?.commands ?? [];
  const now = Date.now();
  const identity = outcomeIdentity(pane);
  const bindings = commands.flatMap((sent) => sent.visibility?.binding ? [sent.visibility.binding] : []);
  if (bindings.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(bindings), new Promise((resolve) => { timer = setTimeout(resolve, BINDING_WAIT_MS); })]);
    clearTimeout(timer);
  }
  const watched = commands.filter((sent) => sent.visibility?.process && !sent.visibility.replaced
    && (sent.visibility.discovering || now < sent.at + COMMAND_WINDOW_MS));
  // The transcript can be megabytes; read it only while a send can still change from it.
  const open = commands.some((sent) => sent.outcome?.state !== "result-observed" && sent.form?.interaction !== "terminal"
    && now < sent.at + COMMAND_WINDOW_MS);
  // one read of the pane's processes serves the binding checks and the transcript's lookup alike; a read that
  // failed answers neither, and the lookup asks herdr itself (an attach client found there names the job's session)
  let processes: ProcessInfo | undefined;
  let processesRead = false;
  if (watched.length > 0 || open) {
    try {
      processes = await paneProcessInfo(paneId);
      processesRead = true;
    } catch {}
  }
  for (const [index, sent] of commands.entries()) {
    const visibility = sent.visibility;
    if (!visibility || visibility.replaced) continue;
    // bound to another process than an earlier send under the same identity: herdr still reports the session
    // of the process before, and this send waits for its own (a send no process was bound to is no evidence)
    if (!visibility.discovering && visibility.stale === undefined && visibility.process
      && commands.slice(0, index).some((earlier) => earlier.visibility?.identity === visibility.identity
        && (earlier.visibility.replaced || earlier.visibility.process && !sameProcess(earlier.visibility.process, visibility.process!)))) {
      visibility.discovering = true;
      visibility.stale = visibility.identity;
    }
    if (visibility.stale !== undefined && visibility.discovering
      && (now >= sent.at + STALE_SESSION_LAG_MS || commands.slice(index + 1).some((later) => later.sessionChange))) {
      visibility.discovering = false;
    }
    const current = processes && watched.includes(sent) ? checkBoundProcess(visibility, sent.agent, processes) : null;
    // A send's own session is adopted while its bound process runs. With no process bound (native Windows
    // lists only the shell; an executable named otherwise than its kind), nothing can show a replacement,
    // so the session that appears in the same terminal is taken as its own, when it is the same agent's:
    // reported under its kind, or under the label herdr gave the pane at the send (an OmO pane's `pi`).
    if (visibility.discovering && !visibility.replaced && pane.agent_session && identity !== visibility.stale
      && visibility.terminalId === pane.terminal_id
      && (current || visibility.unmatched && [sent.agent, visibility.label].includes(pane.agent_session.agent))) {
      visibility.identity = identity;
      visibility.discovering = false;
      if (sent.sessionChange) sent.sessionChange.identity = identity;
    }
  }
  const sameSession = (sent: PaneCommandSend): boolean => !sent.visibility?.replaced
    && (sent.visibility?.identity ?? sent.identity) === identity;
  const transcript = open
    ? await readCommandTranscript(paneId, codexHome, { snapshot, ...processesRead ? { processes: processes ?? null } : {} }).catch(() => null)
    : null;
  if (transcript) chatSent.get(paneId)?.reservations.observeTranscript(outcomeIdentity(pane), transcript.identity, transcript.records, readSendId);
  const parsed = prompt ? parsedByPublicPrompt.get(prompt) : undefined;
  const readIndex = commands.findIndex((sent) => sent.id === readSendId);
  const outcomes = commands.map((sent, index) => {
    if (index > readIndex) return sent.outcome ?? commandOutcome(paneId, sent, { now });
    const same = sameSession(sent);
    const latest = index === commands.length - 1 && same && sent.closedAt === undefined && now < sent.at + COMMAND_WINDOW_MS;
    const reader = parsed ? registry.readerFor(parsed.responder) : undefined;
    const readers = registry.readersFor(sent.agent);
    const before = parsePrompt(sent.agent, sent.screen);
    const dialog = latest && prompt && parsed && reader && reader.kind !== "result" && !prompt.fallback && parsed.id !== before?.id
      && ownsCommandDialog(sent, parsed, screen, reader, readers)
      ? { id: prompt.id, reader: reader.id } : undefined;
    if (dialog && (!sent.form?.dialog || sent.form.dialog === dialog.reader)) {
      sent.dialogId = dialog.id;
      sent.dialogObserved = true;
    }
    else sent.dialogId = undefined;
    if (latest && pane.agent_status === "blocked" && !prompt && reader?.kind !== "result") sent.waitingSince ??= now;
    else sent.waitingSince = undefined;
    if (latest && sent.form?.interaction === "dialog" && !sent.dialogObserved && (!prompt || prompt.fallback)
      && (pane.agent_status === "idle" || pane.agent_status === "done")) {
      const content = dialogSettlingScreen(screen, sent.agent, readers);
      if (content === dialogSettlingScreen(sent.screen, sent.agent, readers)) sent.settled = undefined;
      else if (sent.settled?.screen !== content) sent.settled = { screen: content, since: now };
    } else sent.settled = undefined;
    const nextAt = commands[index + 1]?.at ?? (!same ? now : undefined);
    const observed = commandOutcome(paneId, sent, {
      now, nextAt, screen: latest ? screen : undefined, resultScreen: same ? screen : undefined,
      // the snapshot came before the screen read; a detection read is the live screen, whatever a device scrolled
      top: pane.scroll?.max_offset_from_bottom,
      readers, dialog, settledSince: sent.settled?.since,
      waitingSince: sent.waitingSince,
      transcriptAt: same && sent.transcriptEvidence && sent.transcriptEvidence.at < (sent.transcriptClosedAt ?? Infinity)
        ? sent.transcriptEvidence.at : undefined,
    });
    sent.outcome = observed;
    return observed;
  });
  // The last Chat /clear, /new or resume may itself change sessions. Keep its receipt in
  // that next conversation only; a session change is not proof that the command completed.
  for (const [index, sent] of commands.entries()) {
    const change = sent.sessionChange;
    if (!change || change.identity !== undefined || sent.visibility?.replaced || sameSession(sent)) continue;
    const next = commands[index + 1];
    if (next && next.identity !== sent.identity && next.at < sent.at + COMMAND_WINDOW_MS && change.terminalId === pane.terminal_id) {
      change.identity = next.identity;
    } else if (index === commands.length - 1 && index <= readIndex && sent.closedAt === undefined
      && now < sent.at + COMMAND_WINDOW_MS && pane.agent_session && change.terminalId === pane.terminal_id) {
      change.identity = identity;
    }
  }
  return outcomes.filter((_, index) => {
    const sent = commands[index]!;
    return !sent.visibility?.replaced && (sameSession(sent) || sent.sessionChange?.identity === identity);
  });
}

/** What the chat sent a pane that Claude Code may be holding, for the readers that ask whether it waits. */
let approvalHeld: (paneId: string) => boolean = () => false;

/** Whether the approval hub holds a request of a pane, for a dialog that is a card only then (ParsedPrompt.approvalHeldOnly). */
export function readHeldApprovals(hub: ApprovalHub | null): void {
  approvalHeld = hub === null ? () => false : (paneId) => hub.held(paneId).length > 0;
}

export function heldCandidate(paneId: string): string | null {
  const entry = heldCandidates.get(paneId);
  if (!entry) return null;
  if (Date.now() - entry.at > HELD_WINDOW_MS) { heldCandidates.delete(paneId); return null; }
  return entry.text;
}

/**
 * Codex 0.156 holds the questions it asked with request_user_input_async in a queue above
 * its main prompt, collapsed to "? 2 questions / alt+↑ to answer", and herdr reports the
 * agent blocked meanwhile. Yet the main prompt has the input and takes a message (Codex
 * then drops the questions). True only for that collapsed queue with the main prompt (›)
 * right under it and no other prompt on screen: an open question (its "enter submit …
 * skip" hint) or an approval below the queue holds the input itself.
 */
export function codexQuestionsCollapsed(screen: string): boolean {
  return parsePrompt("codex", screen) === null && queuedQuestionCount(screen) > 0;
}

/**
 * `omoAsk`: the call an omo pane's session waits on (pendingOmoAsk), for its form's own text.
 * `omoTrusted` false: an omo form on the screen counts only when that call matches it.
 */
/** `sent`: what the chat last sent to the pane, and `working`: whether its agent is under a turn, for a message Claude Code holds back (parseClaudeHeld) */
export function parseInteractivePrompt(agent: string, screen: string, omoAsk: OmoAsk | null = null, omoTrusted = true, omoOpen: OmoAsk[] = [], sent: string | null = null, working = false): InteractivePrompt | null {
  const parsed = parsePrompt(agent, screen, omoAsk, omoTrusted, omoOpen, sent, working);
  return parsed ? publicPrompt(parsed) : null;
}

class InvalidAnswer extends Error {}

export function answerKeys(prompt: InteractivePrompt, answer: Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">): AnswerStep[] {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (!parsed) throw new InvalidAnswer("The prompt was not produced by parseInteractivePrompt.");
  if (parsed.piQuestionnaireInput !== undefined) throw new InvalidAnswer("Finish or cancel the terminal-owned questionnaire draft in the terminal.");
  const combined = Boolean(parsed.checks_with_text && parsed.multi_select && answer.option_indices !== undefined && answer.custom_text !== undefined && answer.option_index === undefined);
  const supplied = [answer.option_index !== undefined, answer.option_indices !== undefined, answer.custom_text !== undefined].filter(Boolean).length;
  if (supplied !== 1 && !combined) throw new InvalidAnswer("Exactly one answer is required.");

  if (answer.custom_text !== undefined) {
    if (typeof answer.custom_text !== "string") throw new InvalidAnswer("Custom text must be a string.");
    // A raw newline/control in rpiv's inline input can submit it and type into the next
    // question, review, or composer. Validate before trimming and before any navigation.
    if ((parsed.responder === "pi-ask-question" || parsed.responder === "pi-questionnaire-question") && /[\u0000-\u001f\u007f-\u009f]/.test(answer.custom_text)) {
      throw new InvalidAnswer("Pi custom answers must be one line without control characters.");
    }
    // dsh-tui reads a control byte inside the typed run as its key (measured on 0.20.0): ESC [B moves to an option the
    // answer then carries, Ctrl+C or a lone ESC cancels the question
    if ((parsed.responder === "agy-question" || parsed.responder === "dsh-question") && (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]|\r(?!\n)/.test(answer.custom_text))) {
      throw new InvalidAnswer("Custom text contains unsupported control characters.");
    }
    // Letta's model search takes each character as a key: a control one is a command there (Enter picks, Esc closes
    // the picker), and one past U+FFFF (or half of one) is not the one unit a key of Letta's search holds (dialogs/letta.ts)
    if (parsed.responder === "letta-model" && /[\u0000-\u001f\u007f-\u009f\u{d800}-\u{dfff}\u{10000}-\u{10ffff}]/u.test(answer.custom_text)) {
      throw new InvalidAnswer("A model search must be one line of plain characters.");
    }
    if (parsed.responder === "letta-model" && answer.custom_text.trim().length > LETTA_SEARCH_MAX) {
      throw new InvalidAnswer(`A model search holds at most ${LETTA_SEARCH_MAX} characters.`);
    }
    const text = answer.custom_text.trim();
    if (!text || parsed.customMenuIndex === null || (parsed.multi_select && parsed.responder !== "claude-question" && !parsed.checks_with_text)) throw new InvalidAnswer("This prompt does not accept a custom answer.");
    let picked: number[] | undefined;
    if (answer.option_indices !== undefined) {
      if (!Array.isArray(answer.option_indices)) throw new InvalidAnswer("Option indices must be an array.");
      picked = [...new Set(answer.option_indices)];
      if (picked.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= parsed.options.length)) {
        throw new InvalidAnswer("An option index is outside the displayed range.");
      }
      // ticks with typed text are sent only by a card whose own steps take both (agy's write-in); any other card that
      // says it takes them (pi-ask's form, answered through its bridge) would type the text and drop the ticks
      if (!parsed.customSteps) throw new InvalidAnswer("This prompt does not take ticks and typed text together.");
    }
    if (parsed.responder === "fallback-gjc-menu") {
      if (/[\r\n]/.test(text)) throw new InvalidAnswer("Use the terminal for a multiline GJC custom answer.");
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new InvalidAnswer("Custom text contains unsupported control characters.");
      // GJC handles bracketed paste atomically without /, @ or # autocomplete, as in core/pending.ts.
      return [...keySteps([...navigationKeys(parsed.customMenuIndex - parsed.selectedIndex), KEY.enter]), { text: `\u001b[200~${text}\u001b[201~` }, ...keySteps([KEY.enter])];
    }
    if (parsed.customSteps) return parsed.customSteps(text, picked);
    // Claude's multiple choice: typing into the row ticks it, and Enter on Submit, the row under
    // it, sends the choice (→ in the row would move the text's cursor; measured on 2.1.301)
    if (parsed.multi_select) return [...keySteps(navigationKeys(parsed.customMenuIndex - parsed.selectedIndex)), { text }, ...keySteps([KEY.down, KEY.enter])];
    const navigation = navigationKeys(parsed.customMenuIndex - parsed.selectedIndex);
    // Codex's queue types into its last row once it is selected: no enter first. pi's text
    // dialog is the same but for a worse reason: its `>` line already owns the input, so an
    // enter typed before the answer submits the dialog empty and leaves the answer behind to
    // be typed into the agent's own prompt.
    if (!["claude-question", "claude-plan", "codex-question", "codex-async-question", "pi-input"].includes(parsed.responder)) navigation.push(KEY.enter);
    if (parsed.responder === "codex-question") navigation.push(KEY.tab);
    // what was typed into pi's line in the terminal would stay around the answer: the line is
    // emptied first, after the cursor and before it (pi's editor keys, measured on 0.87.1)
    if (parsed.responder === "pi-input") navigation.push("ctrl+k", "ctrl+u");
    // Claude's plan too: Enter on "Tell Claude what to change" sends the words and keeps planning,
    // where shift+tab approves the plan with them (measured on 2.1.316)
    return [...keySteps(navigation), { text }, ...keySteps([KEY.enter])];
  }

  if (answer.option_indices !== undefined) {
    if (!Array.isArray(answer.option_indices)) throw new InvalidAnswer("Option indices must be an array.");
    if (!parsed.multi_select || answer.option_indices.length === 0) throw new InvalidAnswer("This prompt requires one or more selections.");
    const choices = [...new Set(answer.option_indices)];
    if (choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= parsed.options.length)) {
      throw new InvalidAnswer("An option index is outside the displayed range.");
    }
    if (parsed.multiSteps) return parsed.multiSteps(choices);
    const desired = new Set(choices);
    const checked = new Set(parsed.checkedOptionIndices);
    const toggles = parsed.options.flatMap((_, index) => desired.has(index) !== checked.has(index) ? [index] : []);
    let cursor = parsed.selectedIndex;
    const keys: string[] = [];
    for (const optionIndex of toggles) {
      keys.push(...navigationKeys(optionIndex - cursor), parsed.responder === "omp-question" ? KEY.space : KEY.enter);
      cursor = optionIndex;
    }
    if (parsed.responder === "omp-question") keys.push(KEY.tab, KEY.enter);
    // → leaves the choice for the next question or the review of the answers, never an
    // enter: on the next question it would pick that question's first option
    else if (parsed.responder === "claude-question") keys.push(KEY.right);
    else throw new InvalidAnswer("This agent does not support multiple selections.");
    return keySteps(keys);
  }

  const index = answer.option_index;
  if (!Number.isInteger(index) || index! < 0 || index! >= parsed.options.length || index === parsed.custom_option_index || parsed.multi_select) {
    throw new InvalidAnswer("A valid option index is required.");
  }
  if (parsed.optionSteps) return parsed.optionSteps[index!]!;
  if (parsed.rejectWithEscapeIndex === index) return keySteps([KEY.escape]);
  return keySteps([...navigationKeys(index! - parsed.selectedIndex), KEY.enter]);
}

/**
 * The panes whose current wait on an unknown screen is logged: once per wait, not per screen,
 * so a screen that keeps changing (a clock, a spinner) cannot log on every poll.
 */
const fallbackLogged = new Set<string>();
const FALLBACK_LOGGED_MAX = 256;

/**
 * The question each pane's queue opened on when that was not the card's (a skipped
 * question leaves the rollout's newest-first guess behind): the next card shows it.
 */
const queueFronts = new Map<string, QueueFront & { rollout: string }>();

/**
 * A prompt's own id is a hash of what it says, so the same question asked twice in a row would be one card: an
 * answer tapped for the first asking (or a typed pick left waiting for Confirm) would go to the second.
 */
/**
 * `picked`: a Letta picker answered with its Enter (a model, a level), by what it says: Letta redraws a moment after
 * the key, and until a read shows anything else that drawing is the asking just answered, never a new one
 */
interface Asking { content: string | null; n: number; queued: boolean; call?: string; gjcCall?: string; picked?: string }
const askings = new Map<string, Asking>();
let askingCount = 0;
const SERVER_RUN = randomBytes(6).toString("hex");
/**
 * The panes an answer is on its way to. Its keys redraw the menu (a move, a row opened for typing,
 * pi's dialog with its cursor off the first row), so what another read finds meanwhile says
 * nothing about the asking: it neither ends it nor starts one.
 */
const answersUnderWay = new Set<string>();
const answerTurns = new Map<string, number>();

function asked(paneId: string, prompt: InteractivePrompt | null, turns: number): InteractivePrompt | null {
  let asking = askings.get(paneId);
  if (prompt !== null && asking?.picked !== undefined && asking.picked === lettaPick(parsedByPublicPrompt.get(prompt))) return null;
  if (!answersUnderWay.has(paneId) && (answerTurns.get(paneId) ?? 0) === turns) {
    if (asking) asking.picked = undefined;
    if (prompt === null) {
      if (asking) asking.content = null;
      return null;
    }
    const parsed = parsedByPublicPrompt.get(prompt);
    const call = parsed?.ompCall;
    const gjcCall = parsed?.gjcCall;
    // the same drawing under another ask call is another asking: omp/gjc asked again with the same questions;
    // a bound gjc ask card never shares an asking or public id with an unbound screen read
    if (asking?.content !== prompt.id
      || (call !== undefined && asking.call !== undefined && asking.call !== call)
      || asking.gjcCall !== gjcCall) {
      asking = { content: prompt.id, n: askingCount += 1, queued: prompt.queued !== undefined, ...(gjcCall === undefined ? {} : { gjcCall }) };
      askings.set(paneId, asking);
    }
    if (call !== undefined) asking.call = call;
  }
  if (prompt === null) return null;
  const gjcBound = parsedByPublicPrompt.get(prompt)?.gjcCall;
  prompt.id = createHash("sha256").update(JSON.stringify(
    gjcBound === undefined ? [prompt.id, SERVER_RUN, asking?.n ?? 0] : [prompt.id, SERVER_RUN, asking?.n ?? 0, gjcBound],
  )).digest("hex").slice(0, 12);
  return prompt;
}

function askingEnded(paneId: string): void {
  const asking = askings.get(paneId);
  if (asking) asking.content = null;
}

/**
 * The pane's agent is back at work: it has had its answer, maybe from a terminal, and the same
 * prompt on its screen after this is asked anew. Not so for a question in Codex's queue, which
 * Codex asks while it works and goes on working under: its status says nothing about the
 * question.
 */
export function promptWaitEnded(paneId: string): void {
  if (!askings.get(paneId)?.queued) askingEnded(paneId);
}

function contentId(prompt: InteractivePrompt | null): string | undefined {
  return prompt ? parsedByPublicPrompt.get(prompt)?.id : undefined;
}

const formsAnswered = new Map<string, number>();
const FORM_SETTLE_MS = 3_000;

const defaultOpenCodeState = new OpenCodePromptState();

/** Whether herdr reports the pane running OpenCode on this session now: a card's binding, read again after an awaited lookup. */
async function openCodePaneOn(paneId: string, sessionID: string, openCodeState: OpenCodePromptState, deadlineAt: number): Promise<boolean> {
  const before = openCodeState.checkpoint();
  const snapshot = await openCodeState.snapshot(Math.max(1, deadlineAt - Date.now())).catch(() => null);
  if (!snapshot) return false;
  openCodeState.reconcile(snapshot.panes, before);
  const live = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
  return !!live && live.agent === "opencode" && opencodeSessionId(live) === sessionID;
}

/** Each pane's rollout, resolved for its collapsed queue: a poll every 2s would otherwise redo it. */
const queueRollouts = new Map<string, { path: string | null; at: number }>();
const QUEUE_ROLLOUT_MS = 15_000;

/**
 * The chat's own message back in Claude's box (claudeRestoredDraft), only when the live screen holds
 * it: a pane scrolled into its history can show an older box with the same words.
 */
async function restoredOnLiveScreen(paneId: string, viewport: string): Promise<string | null> {
  // the last chat send remains owned when Claude puts a cancelled send back in its input box
  const sent = lastChatSubmitted(paneId);
  const plain = (text: string): string => text.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  if (claudeRestoredDraft(plain(viewport), viewport, sent) === null) return null;
  const detection = async (): Promise<string> => (await paneRead({ paneId, source: "detection", format: "text", timeoutMs: SUGGESTION_READ_MS })).text;
  const before = await detection();
  if (!claudeInputDraft(before, null)) return null;
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = await detection();
  return viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? claudeRestoredDraft(live, colors, sent) : null;
}

/**
 * Claude's own input box ending the screen: a `❯` or bash `!` row between the last two rules, and
 * only Claude's footer under them (as parseClaudeHeld reads the box). A list's cursor row (`❯ 1.`)
 * between two rules, or a dialog drawn under the box, is no input box.
 */
function claudeInputBoxEndsScreen(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const bottom = findLastIndex(lines, (line) => isDivider(line));
  const footer = lines.slice(bottom + 1).map(cleanLine).filter(Boolean);
  if (bottom < 0 || footer.length > 8 || footer.some((line) => line.startsWith("❯"))) return false;
  const content = claudeInputBoxContent(screen) ?? "";
  return /^[❯!]/.test(content) && !/^❯\s*\d+\./.test(content);
}

export async function readPrompt(paneId: string, codexHome?: string, openCodeStateDir?: string, openCodeState = defaultOpenCodeState, signal?: AbortSignal): Promise<{ agent: string; status: string; prompt: InteractivePrompt | null; pane: HerdrPane; panes: HerdrPane[]; snapshot: SessionSnapshot; screen?: string; stale?: boolean; inputUnverified?: true }> {
  const before = openCodeState.checkpoint();
  const snapshot = await openCodeState.snapshot();
  const { panes } = snapshot;
  for (const logged of fallbackLogged) if (!panes.some((candidate) => candidate.pane_id === logged)) fallbackLogged.delete(logged);
  for (const known of askings.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) askings.delete(known);
  for (const known of answerTurns.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) answerTurns.delete(known);
  for (const known of heldCandidates.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) heldCandidates.delete(known);
  for (const known of chatSent.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) chatSent.delete(known);
  openCodeState.reconcile(panes, before);
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const agent = labelledAgent(pane.agent) ?? "";
  const status = waitStatus(pane, agent);
  const turns = answerTurns.get(paneId) ?? 0;
  const known = await readKnownPrompt(paneId, pane, agent, codexHome, panes, openCodeStateDir, openCodeState, signal, true);
  if (known.stale) return { agent, status, prompt: null, pane, panes, snapshot, stale: true };
  const fallback = await fallbackCard(paneId, agent, status, known);
  if (!fallback) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, known.prompt, turns), pane, panes, snapshot, screen: known.screen, inputUnverified: known.inputUnverified };
  }
  if (!fallback.prompt) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, null, turns), pane, panes, snapshot, screen: fallback.screen };
  }
  const prompt = asked(paneId, fallback.prompt, turns)!;
  if (!fallbackLogged.has(paneId) && fallbackLogged.size < FALLBACK_LOGGED_MAX) {
    fallbackLogged.add(paneId);
    console.warn(`prompt: ${agent} pane ${paneId} is blocked on a screen no reader knows; fallback card (${prompt.options.length} options)`);
  }
  return { agent, status, prompt, pane, panes, snapshot, screen: fallback.screen, inputUnverified: known.inputUnverified };
}

/**
 * The pane's status as its agent says it: Letta says it waits for the user's approval only in its own title
 * (agent-identity.ts `titleStatus`), which herdr-core does not take for a status, as the session's rows do.
 */
function waitStatus(pane: HerdrPane, agent: string): HerdrPane["agent_status"] {
  return titleStatus(agent, pane.terminal_title) === "blocked" ? "blocked" : pane.agent_status;
}

async function fallbackCard(paneId: string, agent: string, status: string | undefined, known: { prompt: InteractivePrompt | null; screen?: string; suppressFallback?: true }): Promise<{ prompt: InteractivePrompt | null; screen: string } | null> {
  // A custom form just answered can close before Herdr stops reporting blocked. Its hint may
  // outlive the widget, but that is no input to offer as fallback keys. Known next steps still
  // show immediately; only an unrecognized screen waits for this bounded settling window.
  const settling = Date.now() - (formsAnswered.get(paneId) ?? 0) < FORM_SETTLE_MS;
  if (known.prompt !== null || known.suppressFallback || !agent || settling) return null;
  // herdr reports some agents at rest under a picker of their own (their folder trust at start): read only for agents
  // no reader knows, the one pass that may show the card while herdr says no answer is waited for
  if (status !== "blocked" && SCREEN_READ_AGENTS.has(agent)) return null;
  const screen = known.screen ?? await liveScreen(paneId);
  if (status !== "blocked" && !agentPickerWaits(agent, screen)) return null;
  // Codex's collapsed question queue reads blocked while its main prompt takes a message; a
  // model list of Claude Code's or Codex's that no reader could read is left to the terminal
  // (registry.waits); Claude's own input box (a `❯` or bash `!` row between the last two rules)
  // ending the screen is no dialog: herdr says blocked a moment before Claude draws its panel,
  // and for a second or two after it closes
  if ((agent === "codex" && codexQuestionsCollapsed(screen)) || registry.waits(agent, screen)
    || (agent === "claude" && claudeInputBoxEndsScreen(screen))) return { prompt: null, screen };
  const fallback = parseFallbackPrompt(agent, screen);
  if (agent === "gjc" && parsedByPublicPrompt.get(fallback)?.responder === "fallback-gjc-menu") {
    return { prompt: await withGjcFallback(paneId, fallback, screen, true), screen };
  }
  const card = await withAgentRecord(paneId, agent, fallback, screen);
  return { prompt: card, screen };
}

const piAskReader = new OmoAskReader(); // Pi and OmO share the message/toolCall JSONL envelope.

/**
 * Whether no key may go into the pi pane: the web UI's pi-ask extension serves the pane's pi (its
 * socket answers, or cannot be read), so a pi-ask form can open there at any moment, between any
 * check and the key that follows it. pi-ask takes no typed keys (its docs/remote-events.md): such a
 * pane gets no key-driven card at all, pi's own dialogs included, and the terminal answers them.
 * The pi-ask card answers through the extension instead. A pi without the extension is as on main.
 */
async function piAskRefusesKeys(paneId: string, signal?: AbortSignal): Promise<boolean> {
  return await piAskActivity(paneId, signal) !== "absent";
}

export class KeyRefused extends Error {}

class PiAskFormOpen extends KeyRefused {}

/**
 * Whether omp itself holds the pane's input: one of its own processes is in the pane's foreground (herdr's
 * `pane.process_info`). herdr keeps naming the pane omp while omp is stopped behind its shell (job control,
 * live-verified with herdr 0.9.5: the foreground is then the shell alone), and the screen can still show omp's
 * last dialog: a key answered there would go to the shell. Unknown (herdr did not answer) is not omp's. Windows
 * has no job control and no foreground process group (process_info names only the shell there,
 * windows-processes.ts), so nothing can stand in front of a running omp: its panes are read as before.
 */
async function ompOwnsInput(paneId: string, signal?: AbortSignal): Promise<boolean> {
  if (process.platform === "win32") return true;
  const info = await untilAborted(paneProcessInfo(paneId), signal);
  return agentProcesses(info?.foreground_processes ?? [], "omp").length > 0;
}

function untilAborted<T>(look: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  const settled = look.catch(() => undefined);
  if (!signal) return settled;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const stop = (): void => resolve(undefined);
    signal.addEventListener("abort", stop, { once: true });
    void settled.then((value) => { signal.removeEventListener("abort", stop); resolve(value); });
  });
}

class OmpNotInFront extends KeyRefused {}

class PiNotInFront extends KeyRefused {}

/**
 * Whether pi itself holds the pane's input, as ompOwnsInput asks for omp: the screen pi leaves behind
 * when it ends, its last dialog with one line of the shell's under it, reads like a dialog over an
 * extension's status line (piFooterLines), and a key answered there would go to the shell. herdr
 * names an omo pane pi too, and omo is pi's own build. Unknown (herdr did not answer) is not pi's.
 * Windows lists no foreground process group: read as before. A cancelled answer's signal is not
 * awaited here: its moves end as they did before this look (the answer path decides on cancelling).
 */
async function piOwnsInput(paneId: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  const info = await paneProcessInfo(paneId).catch(() => null);
  return (info?.foreground_processes ?? []).some((entry) => isPiProcess(entry.argv ?? [])
    || agentProcesses([entry], "pi").length > 0 || agentProcesses([entry], "omo").length > 0);
}

/**
 * Whether Hermes holds the pane's input (it is the pane's foreground process), not a shell it was
 * suspended behind (Ctrl+Z), where herdr still names the pane Hermes and anything run there can show an
 * approval's text. Unknown (herdr did not answer) is not Hermes's, and neither is Windows, which lists no
 * foreground process group: its approval stays for the terminal there, as one this reader leaves out.
 */
async function hermesOwnsInput(paneId: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  const info = await paneProcessInfo(paneId).catch(() => null);
  return (info?.foreground_processes ?? []).some(isHermesForeground);
}

/**
 * The foreground process is Hermes itself: its own executable, Python running its entry script,
 * or the installer's inline CLI launcher. Other Python code must not take an approval's keys
 * even when its arguments contain a path named Hermes.
 */
export function isHermesForeground(entry: { name?: string | null; argv0?: string | null; argv?: readonly string[] | null }): boolean {
  const named = (value: string) => {
    const lower = value.toLowerCase();
    return lower === "hermes" || lower === "hermes.exe" || lower.endsWith("/hermes") || lower.endsWith("\\hermes.exe");
  };
  const argv = entry.argv ?? [];
  if (isHermesInstalledLauncher(argv)) return true;
  const first = argv[0] ?? entry.argv0 ?? entry.name ?? "";
  if (named(first)) return true;
  const interpreter = (first.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!/^python[\d.]*(?:\.exe)?$/u.test(interpreter)) return false;
  // Python's own options before the script, read as Python reads them, combined flags included (-uX opt): -c and -m
  // run something else, -X/-W/-Q take a value (the rest of the argument, or the next one), and a long option this
  // does not know may take one too, so it is no Hermes
  for (let at = 1; at < argv.length; at += 1) {
    const arg = argv[at]!;
    if (arg === "--") return named(argv[at + 1] ?? "");
    if (arg.startsWith("--")) return false;
    if (!arg.startsWith("-") || arg === "-") return named(arg);
    for (let flag = 1; flag < arg.length; flag += 1) {
      const option = arg[flag]!;
      if (option === "c" || option === "m") return false;
      if (option === "X" || option === "W" || option === "Q") {
        if (flag === arg.length - 1) at += 1;
        break;
      }
    }
  }
  return false;
}

class MoveLapsed extends KeyRefused {}

/**
 * Right before each key an answer or a move sends: a pi-ask form that opened since the read takes none of them,
 * and an omp stopped behind its shell since the read takes none either: the shell would. A stop between this
 * look and herdr writing the key is not seen: herdr's send_keys takes no condition on the foreground.
 */
async function beforeKey(paneId: string, agent: string, deadline: AbortSignal): Promise<void> {
  if (agent === "pi" && await piAskRefusesKeys(paneId, deadline)) throw new PiAskFormOpen();
  if (agent === "omp" && !(await ompOwnsInput(paneId, deadline))) throw new OmpNotInFront();
}

class DshNotAsking extends KeyRefused {}

async function dshAsks(paneId: string, signal: AbortSignal): Promise<boolean> {
  const pane = await untilAborted(paneGet(paneId), signal);
  return pane?.agent === "dsh-tui" && pane.agent_status === "blocked";
}

class OmpCallChanged extends KeyRefused {}

/** The request a card read from its agent's record is no longer the one the record holds open (record-cards.ts). */
class RecordChanged extends KeyRefused {}

async function ompCallStillOpen(paneId: string, cwd: string, call: string, deadline: AbortSignal): Promise<boolean> {
  if (!cwd) return false;
  const open = await untilAborted((async () => {
    const path = (await ompTranscriptPath(paneId, cwd)).path;
    return ompOpenCall(ompAskReader.read(path), path);
  })(), deadline);
  return open === call;
}
const ompAskReader = new OmoAskReader(ompAsksAfter);

export type OmpLookups = Map<string, { path: string; open: OmoAsks; failures: number }>;
const ompLookups: OmpLookups = new Map();
const OMP_LOOKUP_FAILURES = 3;

async function withOmpMarkdown(paneId: string, cwd: string, prompt: InteractivePrompt, markdown: boolean, lookups: OmpLookups): Promise<{ prompt: InteractivePrompt; unverified?: true; rebind: (prompt: InteractivePrompt) => InteractivePrompt }> {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (parsed?.responder !== "omp-question" && parsed?.responder !== "omp-submit" && !parsed?.nativeSteps) return { prompt, rebind: (card) => card };
  let path = "";
  let open: OmoAsks = [];
  let unverified: true | undefined;
  try {
    if (cwd) {
      path = (await ompTranscriptPath(paneId, cwd)).path;
      open = ompAskReader.read(path);
      lookups.delete(paneId);
      lookups.set(paneId, { path, open, failures: 0 });
      if (lookups.size > 64) lookups.delete(lookups.keys().next().value!);
    }
  } catch (error) {
    const last = lookups.get(paneId);
    if (error instanceof ConversationNotStarted || !last || last.failures + 1 >= OMP_LOOKUP_FAILURES) lookups.delete(paneId);
    // A lookup that fails for a moment (a busy herdr, an unreadable /proc): the card keeps the binding (and id) the last
    // lookup gave, and this read authorizes no key, rather than a card with another id that would start a new asking
    else {
      last.failures += 1;
      ({ path, open } = last);
      unverified = true;
    }
  }
  const called = ompCallPrompt(prompt, open, path);
  const bound = ompStepPrompt(called.prompt, open, path);
  const rebind = (card: InteractivePrompt): InteractivePrompt => ompStepPrompt(ompCallPrompt(card, open, path).prompt, open, path);
  return { prompt: markdown ? ompMarkdownPrompt(bound, open) : bound, unverified: unverified ?? called.unverified, rebind };
}

async function readKnownPrompt(
  paneId: string,
  pane: { cwd?: string | null; agent_status?: string; agent_session?: HerdrPane["agent_session"] },
  agent: string,
  codexHome?: string,
  panes: HerdrPane[] = [],
  openCodeStateDir?: string,
  openCodeState = defaultOpenCodeState,
  signal?: AbortSignal,
  markdown: boolean | "record" | "screen" = false,
  /**
   * for a key's verifying read: once every other look of this read is done, the screen is read again as it was
   * read before and parsed with what this read found; a card the screen no longer draws so authorizes no key
   */
  settle: boolean | "editor" = false,
  ompBindings = ompLookups,
): Promise<{ prompt: InteractivePrompt | null; screen?: string; stale?: boolean; inputUnverified?: true; suppressFallback?: true;
  settled?: InteractivePrompt }> {
  // no native card (no session herdr reports, no verified v2 service, no pending permission or form): OpenCode
  // v1's own question prompt is read off the screen below (dialogs/opencode.ts, #1386), and the fallback card stands
  // for what no reader knows
  native: if (agent === "opencode") {
    const sessionID = opencodeSessionId(pane);
    if (!sessionID) break native;
    const state = openCodeState.begin(paneId, sessionID);
    // only the process service.json names, as /api/info proves it; never a service started here
    const service = await openCodeService(openCodeStateDir, signal, { onWindows: true });
    const config = service?.config ?? null;
    const revision = state.revision;
    const issued = ++state.issued;
    const [forms, permissions] = config ? await Promise.all([
      listPendingQuestionForms(config, sessionID, signal),
      openCodePermissionsRead(service!.version)
        ? listPendingPermissions(config, sessionID, signal).then((listed) => withShellInput(config, listed, state.permissions, signal))
        : null,
    ]) : [null, null];
    if (signal?.aborted || openCodeState.entries.get(paneId) !== state) return { prompt: null, stale: true };
    if (state.revision === revision && issued >= state.applied) {
      state.applied = issued;
      // a request answered elsewhere (its own terminal): OpenCode's dialog closes a moment before herdr stops reporting
      // blocked, the same settling an answer from a card waits out, so no fallback card stands in for it meanwhile
      if (permissions !== null && state.permissions?.some((held) => !permissions.some((listed) => listed.id === held.id))) {
        formsAnswered.set(paneId, Date.now());
        if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
      }
      state.permissions = permissions;
      state.available = forms !== null;
      if (forms !== null) {
        state.listed = forms[0] ?? null;
        if (state.listed === null && state.form !== null) {
          state.draft = undefined;
          state.form = null;
          state.revision++;
        }
      }
    }
    // a pending permission is the card before a form, as the latest read listed it; one a card cannot show whole is
    // left to the fallback card
    const permission = state.permissions?.[0];
    if (permission) {
      const card = openCodePermissionPrompt(permission);
      if (!card) break native;
      return { prompt: publicPrompt(card) };
    }
    const form = state.listed;
    if (!form || form.fields.length === 0) break native;

    const identity = JSON.stringify({
      id: form.id, title: form.title,
      fields: form.fields.map(({ key, type, title, description, required, custom, options }) => ({
        key, type, title, description, required, custom,
        options: options?.map(({ value, label, description }) => ({ value, label, description })),
      })),
    });
    if (state.form !== identity) {
      state.draft = undefined;
      state.form = identity;
      state.revision++;
      state.updatedAt = openCodeState.now();
    }
    const draft = state.draft;
    let stepIndex = 0;
    if (draft && draft.formId === form.id) {
      stepIndex = Math.min(draft.stepIndex, form.fields.length - 1);
    }

    const field = form.fields[stepIndex]!;
    const multiSelect = field.type === "multiselect";
    const rawOptions = field.options ?? [];
    const customAllowed = field.custom === true || rawOptions.length === 0;

    let options: PromptDraft["options"];
    let customOptionIndex: number | null = null;

    if (rawOptions.length === 0) {
      options = [{ label: own("Type your answer"), description: null }];
      customOptionIndex = 0;
    } else {
      options = rawOptions.map((opt) => ({
        label: opt.label || opt.value,
        description: opt.description ?? null,
      }));
      if (customAllowed) {
        options.push({ label: own("Type your own answer"), description: null });
        customOptionIndex = options.length - 1;
      }
    }

    const title = field.title && field.title !== field.description ? field.title : (form.title || own("Question"));
    const question = field.description || field.title || form.title || "";
    const steps = form.fields.length > 1
      ? form.fields.map((f, i) => ({
          label: f.title || own("Question {n}", { n: i + 1 }),
          answered: i < stepIndex,
          current: i === stepIndex,
        }))
      : undefined;

    let defaultOptionIndex: number | null = null;
    let defaultOptionIndices: number[] | undefined;
    let defaultCustomText: string | undefined;

    const savedAnswer = draft?.answers[field.key];
    if (savedAnswer !== undefined) {
      if (Array.isArray(savedAnswer)) {
        defaultOptionIndices = savedAnswer
          .map((val) => rawOptions.findIndex((opt) => opt.value === val))
          .filter((idx) => idx >= 0);
        if (customAllowed) defaultCustomText = savedAnswer.filter((value) => !rawOptions.some((option) => option.value === value)).join("\n") || undefined;
      } else if (typeof savedAnswer === "string") {
        const optIdx = rawOptions.findIndex((opt) => opt.value === savedAnswer);
        if (optIdx >= 0) {
          defaultOptionIndex = optIdx;
        } else if (customAllowed) {
          defaultCustomText = savedAnswer;
        }
      }
    }

    const parsed = finishPrompt(
      "opencode",
      {
        kind: "question",
        title,
        question,
        body: null,
        options,
        multi_select: multiSelect,
        ...(field.required === false ? { optional: true as const } : {}),
        custom_option_index: customOptionIndex,
        steps,
        can_step_back: stepIndex > 0,
        default_option_index: defaultOptionIndex,
        default_option_indices: defaultOptionIndices,
        default_custom_text: defaultCustomText,
      },
      {
        responder: "opencode-question",
        menuLabels: [],
        selectedIndex: 0,
        checkedOptionIndices: [],
        customMenuIndex: customOptionIndex,
        rejectWithEscapeIndex: null,
        openCodeForm: {
          formId: form.id,
          fieldKey: field.key,
          stepIndex,
          totalSteps: form.fields.length,
          options: rawOptions,
          sessionID,
          state,
          revision: state.revision,
          available: state.available,
        },
      },
      { call: `${sessionID}:${identity}:${field.key}:${stepIndex}` },
    );

    return { prompt: publicPrompt(parsed) };
  }

  // Antigravity's question has a reader (dialogs/agy.ts); its other screens, the folder trust at start among them, stay
  // with the fallback card and the picker guard, so it is named here and not in SCREEN_READ_AGENTS; dsh-tui's
  // ask_user_question has a reader too (dialogs/dsh.ts), read only while herdr says the pane waits on the user, as
  // its fallback card is: a panel's text on the screen of a dsh that is not asking takes no Enter
  if (!SCREEN_READ_AGENTS.has(agent) && agent !== "agy" && !(agent === "dsh-tui" && pane.agent_status === "blocked")) return { prompt: null };
  const piTranscript = agent === "pi" ? await piTranscriptPath(paneId).catch(() => null) : null;
  // pi-ask's ask_user form, as the web UI's pi extension reports it: answered through pi-ask, never keys
  if (piTranscript && "path" in piTranscript) {
    const card = await bindPiAsk(paneId, piTranscript, signal);
    if (card) return { prompt: publicPrompt(piAskUserPrompt(paneId, piTranscript.path, card)) };
  }
  let screen = await liveScreen(paneId);
  const questionnaire = agent === "pi" && isPiQuestionnaireScreen(screen);
  const piTabs = agent === "pi" && (questionnaire && /[□■]/.test(screen)
    || /^\s*←.*✓ Submit\s*→$/m.test(screen) && /Enter to select · ↑\/↓ to navigate/.test(screen));
  // Claude's question tabs, whole: only the bar's colors say which tab is shown (dialogs/claude.ts)
  const claudeTabs = agent === "claude" && /^\s*\u2190\s+[\u2610\u2612\u2611\u2714].*\u2192\s*$/m.test(screen);
  let inputUnverified: true | undefined;
  const ompTabs = agent === "omp" && (OMP_TABS_HINT_RE.test(screen) || OMP_REVIEW_HINT_RE.test(screen));
  const plain = (value: string): string => value.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .split(/\r?\n/).map(line => line.trimEnd()).join("\n").trimEnd();
  if (piTabs || claudeTabs || ompTabs) {
    // Detection text has no styles. Background or neutral-vs-dim/green text identifies
    // the active tab, not answered boxes: verify the viewport before authorizing moves.
    const before = screen;
    const scrollBefore = await paneScrollInfo(paneId).catch(() => null);
    const colors = await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS }).then(read => read.text, () => null);
    const scrollAfter = await paneScrollInfo(paneId).catch(() => null);
    screen = await liveScreen(paneId);
    if (colors !== null && viewportShowsLive(scrollBefore, scrollAfter, colors, before, screen)
      && plain(colors) === plain(screen)) screen = colors;
    // Plain-text labels remain readable, but authorize no input.
    else if (piTabs) inputUnverified = true;
  }
  // omo's form reads its text from the session's call, the screen showing where the form stands
  const omoAsks = ["omo", "pi", "claude", ""].includes(agent) && pane.cwd && OMO_FORM_RE.test(screen)
    ? await omoAsksFor(paneId, pane.cwd, panes) : [];
  // a pane herdr names claude, or not at all, is omo's only on evidence: herdr reports it waiting
  // on the user, or the session's pending call is the form on screen
  const omoTrusted = (agent !== "claude" && agent !== "") || pane.agent_status === "blocked";
  let piNative: ParsedPrompt | null = null;
  let piNativeAgain: ((drawn: string) => ParsedPrompt | null) | null = null;
  if (agent === "pi") {
    const transcript = piTranscript;
    if (transcript && "path" in transcript) {
      try {
        const calls = pendingPiQuestionnaires(transcript.path);
        if (calls === null && questionnaire) return { prompt: null, screen, suppressFallback: true };
        const matches = (calls ?? []).flatMap(call => {
          const source = piQuestionnaireOf(`${transcript.path}\0${call.id}`, call.args);
          const parsed = source && parsePiQuestionnaire(screen, source);
          return parsed ? [{ parsed, again: (drawn: string) => parsePiQuestionnaire(drawn, source) }] : [];
        });
        if (matches.length === 1) ({ parsed: piNative, again: piNativeAgain } = matches[0]!);
        else if (calls?.length) return { prompt: null, screen, suppressFallback: true }; // never guess keys for a partial custom widget
      } catch { /* Missing or replaced session: no authorization from a screen alone. */ }
    }
  }
  if (piTabs && !questionnaire && !piNative) {
    // A saved custom answer replaces the Other label. Only the pane's verified pending call
    // can prove that last row is still input, not a clipped third/fourth ordinary option.
    const transcript = piTranscript;
    if (transcript && "path" in transcript) {
      try {
        const matches = piAskReader.read(transcript.path).flatMap(call => {
          const ask = omoAskOf({ ...call, id: `${transcript.path}\0${call.id}` });
          const parsed = ask && parsePiAsk(screen, ask);
          return parsed ? [{ parsed, again: (drawn: string) => parsePiAsk(drawn, ask) }] : [];
        });
        if (matches.length === 1) ({ parsed: piNative, again: piNativeAgain } = matches[0]!);
        else screen = screen.replace(ANSI_RE, ""); // no unambiguous call binding: labels, not navigation
      } catch { screen = screen.replace(ANSI_RE, ""); }
    }
  }
  const held = agent === "claude" ? heldCandidate(paneId) : null;
  const parseDrawn = (drawn: string): InteractivePrompt | null => {
    if (piNativeAgain) {
      const again = piNativeAgain(drawn);
      return again ? publicPrompt(again) : null;
    }
    const parsed = parseInteractivePrompt(agent, drawn, omoAsks[0] ?? null, omoTrusted, omoAsks, held, pane.agent_status === "working");
    // a dialog the screen cannot show whole is a card of its own only while the hub holds its request; else it is left
    // to the fallback card, as an agent Ovis did not start
    return heldOnly(parsed) && !approvalHeld(paneId) ? null : parsed;
  };
  let prompt = piNative ? publicPrompt(piNative) : parseDrawn(screen);
  if ((agent === "letta" || agent === "agy") && prompt && !parsedByPublicPrompt.get(prompt)?.responder.startsWith(`${agent}-`)) prompt = null;
  let rebind = (card: InteractivePrompt): InteractivePrompt => card;
  if (prompt && agent === "omp") {
    const read = await withOmpMarkdown(paneId, pane.cwd ?? "", prompt, markdown === true, ompBindings);
    prompt = read.prompt;
    rebind = read.rebind;
    if (read.unverified) inputUnverified = true;
  }
  // every omp card answers by keys, and so would a fallback card: offered only while omp holds the input
  if (agent === "omp" && (prompt !== null || pane.agent_status === "blocked") && !(await ompOwnsInput(paneId))) {
    return { prompt: null, screen, suppressFallback: true };
  }
  // Hermes's approval answers by keys that grant or refuse: offered only while Hermes holds the input.
  // Looked at before the read that settles a key, never after it: a look between that read's check and
  // the key would let a cursor moved meanwhile take the Enter. A Hermes suspended during that read takes
  // that one key at the shell's fresh prompt, where an arrow or Enter runs nothing, and refuses the next
  if (agent === "hermes" && prompt !== null && parsedByPublicPrompt.get(prompt)?.responder === "hermes-approval" && !(await hermesOwnsInput(paneId))) {
    return { prompt: null, screen, suppressFallback: true };
  }
  // its dangerous-command panel, with the command its state.db holds when the panel shows it whole (record-cards.ts)
  const hermesApproval = agent === "hermes" && prompt !== null ? parsedByPublicPrompt.get(prompt) : undefined;
  if (hermesApproval?.responder === "hermes-approval") {
    const request = await recordRequest(paneId, agent);
    const bound = (card: InteractivePrompt): InteractivePrompt => {
      const parsed = parsedByPublicPrompt.get(card);
      return parsed ? publicPrompt(withRecord(parsed, request, screen, recordFor(agent)!)) : card;
    };
    prompt = bound(prompt!);
    rebind = bound;
  }
  // a Codex question its own server waits on: the card is that request's, and an answer goes to it only (codex-question.ts)
  if (agent === "codex" && prompt !== null && parsedByPublicPrompt.get(prompt)?.responder === "codex-question") {
    const bound = (card: InteractivePrompt): InteractivePrompt => {
      const parsed = parsedByPublicPrompt.get(card);
      return parsed ? publicPrompt(withServedAsk(paneId, parsed)) : card;
    };
    prompt = bound(prompt);
    rebind = bound;
  }
  // and every card pi's own dialogs and questionnaires draw, which answer by keys (pi-ask's form answers
  // through the extension and returned above; omo's cards on a pane herdr names pi keep their own checks)
  if (agent === "pi" && prompt !== null && parsedByPublicPrompt.get(prompt)?.responder?.startsWith("pi-") && !(await piOwnsInput(paneId))) {
    return { prompt: null, screen, suppressFallback: true };
  }
  if (prompt && await claudeHeldIsGrey(paneId, prompt)) return { prompt: null, screen };
  // pi-ask's form with no card: pi-ask takes no typed keys (its docs/remote-events.md), so no card
  // that answers by keys is offered, pi's own dialogs included (the answer would refuse them too):
  // the terminal answers it. The pane's pi says so through the extension (any open form, a card or
  // not, with or without a session written yet); without it, an open ask_user call in the session
  // does. Asked after the screen read, so a form that opened during it counts
  // A pi pane gets no generic card: its Enter/Esc would be keys guessed into pi, which may be showing
  // pi-ask's form (it takes no typed keys); the terminal answers what no reader knows. herdr labels an
  // OmO pane `pi` while OmO waits: told apart by its process tree, it keeps the card other agents get
  if (agent === "pi" && (prompt === null || parsedByPublicPrompt.get(prompt)?.responder.startsWith("fallback"))
    && !(await paneRunsOmo(paneId).catch(() => false))) return { prompt: null, screen, suppressFallback: true };
  // a command approval stays: its held request is answered through the approval hub with no key, and a key for it is
  // still refused before it goes (beforeKey)
  if (agent === "pi" && approvalDialog(prompt) === null && await piAskRefusesKeys(paneId, signal)) return { prompt: null, screen, suppressFallback: true };
  if (!prompt && agent === "gjc" && markdown !== false && settle !== "editor") {
    const fallback = parseFallbackPrompt(agent, screen);
    if (parsedByPublicPrompt.get(fallback)?.responder === "fallback-gjc-menu") {
      if (markdown === "screen") return { prompt: fallback, screen };
      return { prompt: await withGjcFallback(paneId, fallback, screen, markdown === true), screen };
    }
  }
  const count = agent === "codex" && prompt === null ? queuedQuestionCount(screen) : 0;
  let settled: InteractivePrompt | undefined;
  if (settle && (prompt || settle === "editor")) {
    const styled = screen.includes("\u001b[");
    const drawn = await (styled
      ? paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS }).then(read => read.text)
      : liveScreen(paneId)).catch(() => null);
    // Typing can change the card's ID or replace the menu with its editor. Compare the editor
    // on this last screen, after the other lookups, using the same parser context as the read.
    if (settle === "editor") {
      if (styled && drawn !== null && plain(drawn) !== plain(await liveScreen(paneId))) return { prompt: null, inputUnverified: true };
      return { prompt: drawn === null ? null : parseDrawn(drawn), screen: drawn ?? undefined, inputUnverified };
    }
    if (prompt) {
      const again = drawn === null ? null : parseDrawn(drawn);
      const now = again ? rebind(again) : null;
      const at = (card: InteractivePrompt): number | undefined => card.steps?.findIndex(step => step.current);
      if (!now || now.id !== prompt.id || at(now) !== at(prompt)) inputUnverified = true;
      else settled = now;
    }
  }
  if (count === 0 || !pane.cwd) return { prompt, screen, inputUnverified, ...(settled ? { settled } : {}) };
  let rollout = queueRollouts.get(paneId);
  if (!rollout || Date.now() - rollout.at > QUEUE_ROLLOUT_MS) {
    const store = await paneCodexHomePlaced(paneId, codexHome);
    rollout = { path: await codexTranscriptPath(paneId, pane.cwd, store.home, undefined, false, store.placed && !codexHome), at: Date.now() };
    queueRollouts.set(paneId, rollout);
    if (queueRollouts.size > 64) queueRollouts.delete(queueRollouts.keys().next().value!);
  }
  try {
    const front = queueFronts.get(paneId);
    if (front && front.rollout !== rollout.path) queueFronts.delete(paneId);
    return {
      prompt: rollout.path ? codexQueuedPrompt(screen, await unansweredCodexQuestions(rollout.path), front?.rollout === rollout.path ? front : null) : null,
      screen,
    };
  } catch {
    return { prompt: null, screen };
  }
}

/**
 * After an answer from the chat: if Codex opened its next question, close the queue, so
 * the main prompt has the input back. Only once another question shows (`answered` is the
 * id of the one just answered, which can still be on screen for a moment). alt+↓ elsewhere,
 * on the main prompt or an approval, changes nothing (checked on Codex 0.156.1).
 */
async function closeQueue(paneId: string, answered: string): Promise<void> {
  const since = Date.now();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Bun.sleep(100);
    const screen = await liveScreen(paneId);
    const shown = parsePrompt("codex", screen);
    if (shown?.responder === "codex-async-question") {
      // the question just answered, a moment ago; still there after 600ms, it is its twin
      // (Codex takes the Enter at once, and questions may repeat a title and options)
      if (shown.id === answered && Date.now() - since < 600) continue;
      await paneSendKeys(paneId, [KEY.closeQueue]);
      return;
    }
    if (queuedQuestionCount(screen) > 0 || shown === null) return;
  }
}

/**
 * Opens Codex's collapsed queue on its first question and returns that question, only
 * if it is the one the card showed (title and options). Another one is kept in `queueFronts`,
 * so the chat's next read shows the question actually waiting (a skip can leave the rollout's
 * guess behind), and the queue is closed again.
 */
async function openQueuedQuestion(paneId: string, queued: ParsedPrompt, givenUp: () => boolean = () => false, opens: (open: boolean) => void = () => undefined): Promise<InteractivePrompt | null> {
  if (queuedQuestionCount(await liveScreen(paneId)) === 0 || givenUp()) return null;
  // told before the key goes: it may be pressed and its reply still be lost
  opens(true);
  await paneSendKeys(paneId, [KEY.openQueue]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(100);
    const opened = parsePrompt("codex", await liveScreen(paneId));
    if (opened?.responder !== "codex-async-question") continue;
    if (sameText(opened.question, queued.question) && opened.options.length === queued.options.length
      && opened.options.every((option, index) => sameText(option.label, queued.options[index]!.label))) return publicPrompt(opened);
    const rollout = queueRollouts.get(paneId)?.path;
    if (rollout) queueFronts.set(paneId, { question: opened.question, options: opened.options.map((option) => option.label), rollout });
    if (queueFronts.size > 64) queueFronts.delete(queueFronts.keys().next().value!);
    break;
  }
  // not the card's question (a skip can leave the rollout's guess behind), or nothing opened:
  // never leave the queue open, where it would hold the input a message goes to. The one
  // close of this request's opening, told before it is tried: if its reply is lost, nobody
  // closes a second time what another client may have opened since
  opens(false);
  await closeOpenQuestion(paneId);
  return null;
}

async function closeOpenQuestion(paneId: string): Promise<void> {
  const screen = await liveScreen(paneId);
  if (parsePrompt("codex", screen)?.responder === "codex-async-question") await paneSendKeys(paneId, [KEY.closeQueue]);
}

const SETTLE_MS = 1_500;

/** A screen that does not move within a second leaves it to the card's next poll. */
async function formMovedOn(paneId: string, still: (prompt: InteractivePrompt | null) => boolean, codexHome?: string, openCodeStateDir?: string): Promise<void> {
  const deadlineAt = Date.now() + 1_000;
  for (let attempt = 0; attempt < 20 && Date.now() < deadlineAt; attempt += 1) {
    await Bun.sleep(50);
    const read = await readPrompt(paneId, codexHome, openCodeStateDir).catch(() => undefined);
    if (read === undefined || read.stale) continue;
    if (!still(read.prompt)) return;
  }
}

const sameContent = (answered: string | undefined) => (prompt: InteractivePrompt | null): boolean => contentId(prompt) === answered;

/**
 * Claude's question (AskUserQuestion) just answered, still on screen: its question with the same
 * options, whatever is ticked (a tick marks its tab answered, and the card's title changes with it),
 * or the review still up. Any other dialog of Claude's (a tool approval, a plan, the folder-trust
 * check): the same panel, whatever its options say (the plan's feedback row shows the typed answer).
 * A screen no reader knows while Claude still waits (the fallback card) is the next step half drawn.
 */
function claudeStepStill(answered: ParsedPrompt): (prompt: InteractivePrompt | null) => boolean {
  return (prompt) => {
    if (prompt?.fallback === true) return true;
    const shown = prompt ? parsedByPublicPrompt.get(prompt) : undefined;
    if (!shown) return false;
    if (answered.responder === "claude-submit") return shown.responder === "claude-submit";
    if (answered.responder !== "claude-question") return shown.responder === answered.responder && shown.title === answered.title
      && shown.question === answered.question && shown.body === answered.body;
    return shown.responder === "claude-question" && shown.question === answered.question
      && JSON.stringify(shown.options) === JSON.stringify(answered.options);
  };
}

/** How an answer from a card went to its agent (shared/telemetry.ts TelemetryAnswerWay, but `terminal`, which is no answer from here). */
export type AnswerWay = "native" | "record" | "screen";

/** A card whose text was read from the agent's session record (the call it waits on: omo's, omp's, pi's questionnaire, or a recorded request), not off the screen alone. */
const readFromRecord = (parsed: ParsedPrompt): boolean =>
  parsed.omoQuestion !== undefined || parsed.ompCall !== undefined || parsed.record !== undefined || parsed.responder.startsWith("pi-questionnaire-");

function promptChanged(): Response {
  return jsonResponse({ error: { code: "prompt_changed", message: "The interactive prompt changed; reopen it and try again." } }, 409);
}

export interface PromptRequestOptions {
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  codexHome?: string;
  claudeTranscript?: (paneId: string) => string | null;
  /** the requester can only watch: it gets the screen's card, never the plan file's text or path */
  readOnly?: boolean;
  openCodeStateDir?: string;
  openCodeState?: OpenCodePromptState;
  /**
   * told as an answer begins on a pane; what it gives back is told once the answer ended: the way it went when it was
   * delivered (`native`: through the agent's service, hook, extension or ACP keeper; `record` or `screen`: as keys for a
   * card read from the agent's session record or off the screen), else null
   */
  onAnswering?: (paneId: string) => (way: AnswerWay | null) => void;
  /** the approvals an agent this server started holds through its hook */
  approvals?: ApprovalHub;
  /** the ACP children this server runs: a child's pane gets its keeper's cards, never a read of its screen */
  acp?: AcpCards;
  answerDeadlineMs?: number;
  beforeKey?: (paneId: string, agent: string, deadline: AbortSignal) => Promise<void>;
}

/**
 * The command approval on the screen that keeps a held hook request open (Claude's Bash approval, OmO's permission
 * dialog for a shell command, the one Ovis's pi extension draws like it): null for any other dialog.
 */
const approvalDialog = (prompt: InteractivePrompt | null): ApprovalDialog | null => {
  const parsed = prompt === null ? undefined : parsedByPublicPrompt.get(prompt);
  return parsed?.approvalCommand !== undefined ? { command: parsed.approvalCommand, ...(parsed.approvalKind === undefined ? {} : { kind: parsed.approvalKind }) } : null;
};

/**
 * A command approval built from its held hook request: the agent's words and the whole command, where the screen may
 * have cut, wrapped or mixed them. Its id names that request, so that its Yes or No answers that request and no other
 * (heldRequestOf). The read is also what tells the hooks the screen no longer shows a request, which releases it. The
 * pane's requests are those of the agent Ovis started there, whatever herdr names it now (OmO waiting on its user is
 * pi to herdr).
 */
function withHeldPermission(paneId: string, prompt: InteractivePrompt | null, approvals: ApprovalHub | undefined): InteractivePrompt | null {
  const held = approvals?.shown(paneId, approvalDialog(prompt)) ?? null;
  if (held === null || prompt === null) return heldOnly(prompt) ? null : prompt;
  return { ...prompt, id: `${prompt.id}.${held.id}`, body: heldBody(held) };
}

/** A dialog that is a card only while the hub holds a request for it (ParsedPrompt.approvalHeldOnly): never from the screen alone. */
const heldOnly = (prompt: InteractivePrompt | null): boolean =>
  prompt !== null && parsedByPublicPrompt.get(prompt)?.approvalHeldOnly === true;

/** The held request an answer's card was built on (withHeldPermission), or null for a card built on the screen alone. */
function heldRequestOf(prompt: InteractivePrompt, promptId: string, approvals: ApprovalHub | undefined): string | null {
  return approvals !== undefined && approvalDialog(prompt) !== null && promptId.startsWith(`${prompt.id}.`)
    ? promptId.slice(prompt.id.length + 1) : null;
}

/**
 * A Claude plan card with the whole plan from Claude's plan file, as the screen shows only what fits
 * the pane. The plan's revision is part of the id, so an answer to a card read before the file
 * changed is refused.
 */
async function withPlanFile(prompt: InteractivePrompt | null, transcript: string | null | undefined): Promise<InteractivePrompt | null> {
  if (!prompt || !transcript || parsedByPublicPrompt.get(prompt)?.responder !== "claude-plan") return prompt;
  const plan = await claudePlanFile(transcript);
  if (!plan) return prompt;
  const revision = createHash("sha256").update(plan.text).digest("hex").slice(0, 8);
  return { ...prompt, id: `${prompt.id}.${revision}`, body: plan.text.slice(0, 12_000), plan_file: plan.path };
}

/**
 * The prompt the pane shows now, as GET /api/pane/prompt reads it (without a plan's file), and the screen
 * it was read from: what a question's alert offers as buttons (server/push.ts promptActions, which checks
 * the one against the other). Null when none stands, or the read is not one an answer could be checked against.
 */
export async function currentPrompt(paneId: string, options: { codexHome?: string; openCodeStateDir?: string; openCodeState?: OpenCodePromptState; signal?: AbortSignal }): Promise<{ prompt: InteractivePrompt; screen?: string } | null> {
  const read = await readPrompt(paneId, options.codexHome, options.openCodeStateDir, options.openCodeState ?? defaultOpenCodeState, options.signal);
  if (read.stale || read.inputUnverified || !read.prompt || heldOnly(read.prompt)) return null;
  return { prompt: read.prompt, ...(read.screen === undefined ? {} : { screen: read.screen }) };
}

/**
 * `openCodeState` is the watch's own, never the route's: a watch's read, late or from an older snapshot, must not
 * replace the entry or draft an answer uses. A pi pane is not read at all (undefined): its pi-ask card keeps the
 * answers to earlier steps in a draft of the route's (pi-ask-bridge.ts), which a late read of an older form would
 * replace. omp's session lookups are the watch's own too (`ompLookups`), so failing watch reads never use up the ones
 * an answer stands on.
 */
export async function shownPromptText(pane: HerdrPane, panes: HerdrPane[], options: { codexHome?: string; openCodeStateDir?: string; openCodeState: OpenCodePromptState; ompLookups: OmpLookups; answers?: OpenCodePromptState }): Promise<string | null | undefined> {
  const agent = labelledAgent(pane.agent) ?? "";
  if (agent === "pi") return undefined;
  const known = await readKnownPrompt(pane.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir, options.openCodeState, undefined, false, false, options.ompLookups);
  if (known.stale) return undefined;
  const shown = contentId(known.prompt ?? (await fallbackCard(pane.pane_id, agent, waitStatus(pane, agent), known))?.prompt ?? null) ?? null;
  const draft = agent === "opencode" ? (options.answers ?? defaultOpenCodeState).entries.get(pane.pane_id)?.draft : undefined;
  return shown !== null && draft ? `${shown}\0${JSON.stringify(draft)}` : shown;
}

/**
 * The readers whose card is the agent asking its user something it waits on: a permission, a question, a plan to
 * approve, a confirmation or a menu it opened by itself (Claude's folder trust, Codex's continue menu). Not a picker
 * the user opened (a `/model` or `/effort` list, Claude's goal dialog), not a held message, and never a fallback card,
 * which only stands for a status someone reported. pi is not read here (shownPromptText).
 */
const WAITING_RESPONDERS: ReadonlySet<string> = new Set([
  "claude-approval", "claude-confirm", "claude-plan", "claude-question", "claude-submit", "cmd-question",
  "codex-approval", "codex-question", "codex-async-question", "codex-queued-question", "codex-menu",
  "agy-question", "hermes-approval", "hermes-question", "hermes-input", "omo-question", "omo-review", "omo-pending",
  "omp-approval", "omp-question", "omp-submit", "opencode-v1-question", "opencode-question", "opencode-permission",
]);

/** What the waiting a card stands for is about, in the words an agent's own report uses (`kind`); null: it does not say. */
export function waitingKindOf(prompt: InteractivePrompt): "permission" | "question" | null | undefined {
  if (!WAITING_RESPONDERS.has(parsedByPublicPrompt.get(prompt)?.responder ?? "")) return undefined;
  return prompt.kind === "approval" || prompt.kind === "plan" ? "permission" : prompt.kind === "question" ? "question" : null;
}

/**
 * Whether the agent on a pane's screen waits for its user (server/card-waits.ts): the kind of the card a reader
 * returns for it now, null when no such card shows, undefined when the read says nothing (it raced a change, or
 * failed). OpenCode's form kept from a lookup that no longer answers is such a read: the card stays for its user,
 * but whether it is still asked is not known. Read with the caller's own OpenCode and omp state, so it starts and
 * ends no asking.
 */
export async function waitingCard(pane: HerdrPane, panes: HerdrPane[], options: { codexHome?: string; openCodeStateDir?: string; openCodeState: OpenCodePromptState; ompLookups: OmpLookups }): Promise<{ kind: "permission" | "question" | null; id: string } | null | undefined> {
  const agent = pane.agent;
  if (!agent || agent === "pi") return undefined;
  const known = await readKnownPrompt(pane.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir, options.openCodeState, undefined, false, false, options.ompLookups).catch(() => undefined);
  if (known === undefined || known.stale || known.inputUnverified) return undefined;
  if (!known.prompt) return null;
  if (parsedByPublicPrompt.get(known.prompt)?.openCodeForm?.available === false) return undefined;
  const kind = waitingKindOf(known.prompt);
  const id = contentId(known.prompt);
  return kind === undefined || id === undefined ? null : { kind, id };
}

type AnsweringListener = (paneId: string) => (delivered: boolean) => void;
const answeringListeners = new Set<AnsweringListener>();
/**
 * Told the pane as an answer from a card's button begins (POST /api/pane/prompt/answer), before anything is read or
 * typed for it. What the listener gives back is told once that answer ended, whether it was delivered to a card the agent
 * waits on (`waitingKindOf`): never true for a picker the user opened or a fallback card. By then its form has settled
 * and the pane may show its next card, so what the answer was for is the listener's to note as it begins.
 */
export function onPromptAnswering(listener: AnsweringListener): () => void {
  answeringListeners.add(listener);
  return () => { answeringListeners.delete(listener); };
}

const SUGGESTION_PARSERS: Readonly<Record<string, (ansi: string) => string | null>> = {
  claude: parseClaudeSuggestion,
  gjc: parseGjcSuggestion,
  omp: parseOmpSuggestion,
};

export async function handlePromptRequest(request: Request, url: URL, options: PromptRequestOptions = {}): Promise<Response | null> {
  if (url.pathname !== "/api/pane/prompt" && url.pathname !== "/api/pane/prompt/answer") return null;
  setRequestRoute(url.pathname);
  let answerLog: { paneId: string; matched: boolean; record?: RecordOutcome } | null = null;
  /** the answering listeners told of this answer, to be told its end */
  const answering: ((delivered: boolean) => void)[] = [];
  /** keys for this answer went to the pane: also where something after them failed */
  let delivered = false;
  /** the card it matched is one the agent waits on */
  let waitedOn = false;
  /** how the answer went to the agent, once delivered */
  let way: AnswerWay = "screen";
  let answerEnded: ((way: AnswerWay | null) => void) | undefined;
  /** tells the answer's end once */
  const endAnswer = (ended: AnswerWay | null): void => { const told = answerEnded; answerEnded = undefined; told?.(ended); };
  try {
    if (url.pathname === "/api/pane/prompt") {
      if (request.method !== "GET") return badRequest("method_not_allowed", "GET is required.");
      const paneId = url.searchParams.get("pane_id")?.trim();
      if (!paneId) return badRequest("missing_pane_id", "pane_id is required.");
      const acpChild = options.acp?.forPane(paneId);
      if (acpChild) return jsonResponse({ prompt: acpPrompt(acpChild), suggestion: null, restored: null } satisfies PanePromptResponse);
      const readSendId = chatSent.get(paneId)?.commands.at(-1)?.id;
      const read = await readPrompt(paneId, options.codexHome, options.openCodeStateDir, options.openCodeState, request.signal);
      if (read.stale) return promptChanged();
      const { agent, status } = read;
      // `plan=0` is how a connection server asks for a watching device through its PC proxy, which
      // reaches this PC with its own credential: it only ever narrows the answer
      const watching = options.readOnly || url.searchParams.get("plan") === "0";
      const prompt = watching ? read.prompt : await withPlanFile(read.prompt, options.claudeTranscript?.(paneId));
      // no menu up: what the agent suggests typing next (Claude, and gjc and omp with their
      // suggestions turned on), for the composer's placeholder, and the chat's own last message where
      // Claude put it back into the box on a cancel. Only a nicety: it is read only while the agent
      // waits for the next prompt (a working agent shows none), and a failed or slow read of it (a
      // herdr without ansi reads, a busy one) leaves the prompt answer as it is, on time. gjc's and
      // omp's box is read only at the bottom of the screen: a viewport scrolled into the history
      // could end in an older frame of it. The snapshot's scroll is from before the read, so for a
      // suggestion found there, where the viewport is gets asked again (another device may have
      // scrolled meanwhile), within the same short deadline as the read; a look herdr does not
      // answer in time proves nothing, and offers none.
      const parseSuggestion = Object.hasOwn(SUGGESTION_PARSERS, agent) ? SUGGESTION_PARSERS[agent]! : null;
      const scrolled = agent !== "claude" && (read.pane.scroll?.offset_from_bottom ?? 0) > 0;
      // herdr-core (hc) does not know gjc, so a gjc pane there has no status: its box is read all the same, as
      // gjc draws its suggestion only in the empty box after a turn, never while it works (release QA 8a)
      const resting = status === "idle" || status === "done" || (agent === "gjc" && status === "unknown");
      const box = prompt === null && parseSuggestion !== null && !scrolled && resting
        ? await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
          .then((read) => read.text, () => null)
        : null;
      const found = box === null || parseSuggestion === null ? null : parseSuggestion(box);
      const suggestion = found === null || agent === "claude" ? found
        : await paneScrollInfo(paneId, undefined, SUGGESTION_READ_MS).then((scroll) => (scroll?.offset_from_bottom ?? 0) > 0 ? null : found, () => null);
      const outcomes = await commandOutcomes(paneId, read.pane, read.prompt, read.screen, readSendId, options.codexHome, read.snapshot);
      return jsonResponse({
        prompt: withHeldPermission(paneId, prompt, options.approvals),
        suggestion,
        restored: box === null || agent !== "claude" ? null : await restoredOnLiveScreen(paneId, box).catch(() => null),
        ...(outcomes.length ? { outcomes: watching ? outcomes.map(({ preview: _preview, result_text: _resultText, ...outcome }) => outcome) : outcomes } : {}),
      } satisfies PanePromptResponse);
    }

    if (request.method !== "POST") return badRequest("method_not_allowed", "POST is required.");
    let body: PromptAnswer;
    try {
      body = await request.json() as PromptAnswer;
    } catch {
      return badRequest("invalid_json", "The request body must be valid JSON.");
    }
    if (!body || typeof body !== "object") return badRequest("invalid_answer", "The answer body is required.");
    if (typeof body.pane_id !== "string" || !body.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required.");
    if (typeof body.prompt_id !== "string" || !body.prompt_id) return badRequest("invalid_answer", "prompt_id is required.");
    answerEnded = options.onAnswering?.(body.pane_id);
    const acpChild = options.acp?.forPane(body.pane_id);
    if (acpChild) {
      const answered = await answerAcpPrompt(acpChild, body);
      endAnswer(answered === "invalid" || answered === "changed" ? null : "native");
      if (answered === "invalid") return badRequest("invalid_answer", "option_index must name one of the card's options.");
      if (answered === "changed") return promptChanged();
      return jsonResponse({ ok: true });
    }

    const serialize = options.serialize ?? (<T>(_paneId: string, task: () => Promise<T>) => task());
    const form: { still?: (prompt: InteractivePrompt | null) => boolean; record?: { agent: string; id: string } } = {};
    const log: { paneId: string; matched: boolean; record?: RecordOutcome } = { paneId: body.pane_id, matched: false };
    answerLog = log;
    for (const listener of answeringListeners) answering.push(listener(body.pane_id));
    const response = await serialize(body.pane_id, async () => {
      if (request.signal.aborted) return promptChanged();
      const deadlineMs = options.answerDeadlineMs ?? 4_000;
      const deadlineAt = Date.now() + deadlineMs;
      const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]);
      const keyGuard = options.beforeKey ?? beforeKey;
      const openCodeState = options.openCodeState ?? defaultOpenCodeState;
      const first = readPrompt(body.pane_id, options.codexHome, options.openCodeStateDir, openCodeState, deadline);
      first.catch(() => undefined);
      const firstRead = await Promise.race([first, Bun.sleep(Math.max(0, deadlineAt - Date.now())).then(() => null)]);
      if (!firstRead || Date.now() > deadlineAt) return promptChanged();
      const { prompt, agent, pane, panes, inputUnverified } = firstRead;
      if (inputUnverified || !prompt) return promptChanged();
      // a plan card's id carries its plan file's revision: the file as it is now must match too. A command approval's
      // can carry the held hook request it showed: that request must still be held, and still the one on the screen
      const heldId = heldRequestOf(prompt, body.prompt_id, options.approvals);
      if (heldId === null && heldOnly(prompt)) return promptChanged();
      if (heldId !== null ? !options.approvals!.holds(body.pane_id, approvalDialog(prompt)!, heldId)
        : (await withPlanFile(prompt, options.claudeTranscript?.(body.pane_id)))!.id !== body.prompt_id) return promptChanged();
      log.matched = true;
      waitedOn = waitingKindOf(prompt) !== undefined;

      const parsedPrompt = parsedByPublicPrompt.get(prompt);
      // before each key: the look the key needs (beforeKey), then, for an omp card read under an open ask call, that
      // call is still the pane's one open call: omp asking again since the last read takes none of this card's keys
      const ompCall = agent === "omp" ? parsedPrompt?.ompCall : undefined;
      const guardKey = async (paneId: string, keyAgent: string, signal: AbortSignal): Promise<void> => {
        await keyGuard(paneId, keyAgent, signal);
        // a key-driven card of pi's own goes to pi only while pi holds the pane (piOwnsInput)
        if (parsedPrompt?.responder?.startsWith("pi-") && !(await piOwnsInput(paneId))) throw new PiNotInFront();
        // dsh-tui's question card goes to dsh only while herdr still reports it waiting on the user: a dsh that died under
        // the answer can leave its panel on the screen, with the shell after it taking the keys (a picker card at rest
        // keeps main's keys)
        if (parsedPrompt?.responder === "dsh-question" && !(await dshAsks(paneId, signal))) throw new DshNotAsking();
        if (ompCall !== undefined && !(await ompCallStillOpen(paneId, pane.cwd ?? "", ompCall, signal))) throw new OmpCallChanged();
        // a Codex question its server says is answered (from the terminal, or as data) takes no key, whatever the screen still shows
        if (keyAgent === "codex" && parsedPrompt !== undefined && questionClosed(paneId, parsedPrompt)) throw new KeyRefused();
      };
      const verifyThenSend = async <T>(look: AbortSignal, guardUntil: number | null, readUntil: number,
        same: (shown: ParsedPrompt | null, screen: string, settled: ParsedPrompt | null) => boolean, write: () => T, screenOnly: boolean | "editor" = false): Promise<T> => {
        const guarding = guardKey(body.pane_id, agent, look);
        guarding.catch(() => undefined);
        const guarded = guardUntil === null ? await guarding.then(() => true)
          : await Promise.race([guarding.then(() => true), Bun.sleep(Math.max(0, guardUntil - Date.now())).then(() => false)]);
        if (!guarded) throw new KeyRefused();
        if (parsedPrompt?.gjcCall !== undefined && screenOnly === "editor") {
          const checking = gjcCallStillOpen(body.pane_id, parsedPrompt.gjcCall);
          checking.catch(() => undefined);
          const open = await Promise.race([checking, Bun.sleep(Math.max(0, readUntil - Date.now())).then(() => false)]);
          if (!open || Date.now() > readUntil) throw new KeyRefused();
        }
        const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir, openCodeState,
          AbortSignal.timeout(Math.max(1, readUntil - Date.now())),
          agent === "gjc" ? parsedPrompt?.gjcCall !== undefined : true,
          screenOnly === "editor" ? "editor" : !screenOnly);
        reading.catch(() => undefined);
        const read = await Promise.race([reading, Bun.sleep(Math.max(0, readUntil - Date.now())).then(() => null)]);
        const shown = read?.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
        const settled = read?.settled ? parsedByPublicPrompt.get(read.settled) ?? null : null;
        // a stale read (an OpenCode lookup another session overtook) authorizes nothing: it is refused before any
        // comparison, as an empty screen could make the same generic card as the one the answer was read for
        if (read?.stale) throw new KeyRefused();
        const refreshGjcScreen = read !== null && parsedPrompt?.gjcCall !== undefined && screenOnly === true;
        const readsLive = refreshGjcScreen || (read?.screen === undefined && screenOnly === true && parsedPrompt?.responder.startsWith("fallback") === true);
        const screen = refreshGjcScreen
          ? await Promise.race([liveScreen(body.pane_id).catch(() => null), Bun.sleep(Math.max(0, readUntil - Date.now())).then(() => null)])
          : (read?.screen ?? (read && readsLive
            ? await Promise.race([liveScreen(body.pane_id).catch(() => null), Bun.sleep(Math.max(0, readUntil - Date.now())).then(() => null)])
            : null));
        if (readsLive && request.signal.aborted) throw new KeyRefused();
        if (!read || read.inputUnverified || ((screenOnly === "editor" || refreshGjcScreen) && (!screen || read.suppressFallback))
          || Date.now() > readUntil || !same(shown, screen ?? "", settled)) throw new KeyRefused();
        // a card showing its record's command goes to that request only: after the screen's last read, the record must
        // still hold it open, so another request that opened meanwhile with the same command takes none of its keys
        if (parsedPrompt?.record !== undefined && (await recordRequest(body.pane_id, agent))?.id !== parsedPrompt.record.id) throw new RecordChanged();
        // pi's select and confirm compare by the dialog drawn, which pi leaves on the screen when it ends, and a
        // dialog moved off its first row has no card to compare: pi must still hold the pane after this read too
        if ((parsedPrompt?.responder === "pi-question" || parsedPrompt?.responder === "pi-confirm") && !(await piOwnsInput(body.pane_id))) throw new KeyRefused();
        // the reads above yield: a Codex question its server said meanwhile is answered takes no key,
        // and a gjc ask call replaced in its session file during the final screen read takes no key or paste
        if (agent === "codex" && parsedPrompt !== undefined && questionClosed(body.pane_id, parsedPrompt)) throw new KeyRefused();
        if (parsedPrompt?.gjcCall !== undefined && !gjcCallStillOpenInFile(parsedPrompt.gjcCall)) throw new KeyRefused();
        return write();
      };
      // Next goes on to another question and never answers this one: not with an answer in the same body, and not
      // where the card has no supported move (OpenCode would take it as an answer).
      if (body.step_next === true && ((!parsedPrompt?.nativeSteps && !parsedPrompt?.piAskForm && !parsedPrompt?.piAskUser)
        || body.option_index !== undefined || body.option_indices !== undefined || body.custom_text !== undefined)) {
        return badRequest("invalid_answer", "Next goes to another question and answers none.");
      }
      if (parsedPrompt?.responder === "opencode-permission" && parsedPrompt.openCodePermission) {
        const { requestID, sessionID, decisions } = parsedPrompt.openCodePermission;
        const decision = Number.isInteger(body.option_index) ? decisions[body.option_index!] : undefined;
        if (decision === undefined || body.option_indices !== undefined || body.custom_text !== undefined || body.step_back !== undefined
          || body.step_index !== undefined || body.draft !== undefined) return badRequest("invalid_answer", "A valid option index is required.");
        const asking = askings.get(body.pane_id);
        if (!(await openCodePaneOn(body.pane_id, sessionID, openCodeState, deadlineAt)) || deadline.aborted) return promptChanged();
        // the service as it is right before the reply: still the one service.json names, and still a 2.x one
        const service = await openCodeService(options.openCodeStateDir, deadline, { onWindows: true });
        const config = service && openCodePermissionsRead(service.version) ? service.config : null;
        if (!config) return jsonResponse({ error: { code: "service_unavailable", message: "OpenCode service is not available. Your answer has not been sent." } }, 502);
        const replied = await replyOpenCodePermission(config, sessionID, requestID, decision, deadline);
        if (replied.ok) {
          delivered = true;
          way = "native";
          const sent = chatSent.get(body.pane_id)?.commands.at(-1);
          if (sent?.dialogId === prompt.id) noteCommandEvidence(body.pane_id, sent.id, { kind: "native", at: Date.now() });
          formsAnswered.set(body.pane_id, Date.now());
          if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
          if (askings.get(body.pane_id) === asking) askingEnded(body.pane_id);
          // answered: no read listing it from before the reply shows it again
          const entry = openCodeState.entries.get(body.pane_id);
          if (entry?.sessionID === sessionID && entry.permissions) entry.permissions = entry.permissions.filter((request) => request.id !== requestID);
          return jsonResponse({ ok: true });
        }
        if (replied.status === 0) return jsonResponse({ error: { code: "reply_unconfirmed", message: "OpenCode may have received your answer, but its reply did not arrive. Check the request before sending again." } }, 504);
        // answered meanwhile, from its terminal or another client
        if (replied.status === 404) return promptChanged();
        return jsonResponse({ error: { code: "reply_failed", message: `Failed to reply to OpenCode's permission request (HTTP ${replied.status}).` } }, 502);
      }
      if (parsedPrompt?.responder === "opencode-question" && parsedPrompt.openCodeForm) {
        const openCodeForm = parsedPrompt.openCodeForm;
        if (!openCodeForm.available) return jsonResponse({ error: { code: "service_unavailable", message: "OpenCode service is not available. Your answer has not been sent." } }, 502);
        const state = openCodeForm.state;
        const asking = askings.get(body.pane_id);
        const current = (): boolean => !deadline.aborted
          && openCodeState.entries.get(body.pane_id) === state && state.revision === openCodeForm.revision
          && askings.get(body.pane_id) === asking && asking?.content === parsedPrompt.id;
        // The lookup above awaited HTTP. Neither its pane nor its form is a live binding now.
        const stillBound = async (): Promise<boolean> =>
          current() && await openCodePaneOn(body.pane_id, openCodeForm.sessionID, openCodeState, deadlineAt) && current();
        if (!(await stillBound())) return promptChanged();
        const navigating = body.step_back === true || body.step_index !== undefined;
        const supplied = [
          body.option_index !== undefined,
          body.option_indices !== undefined,
          body.custom_text !== undefined,
        ].filter(Boolean).length;
        const combined = parsedPrompt.multi_select && body.option_indices !== undefined && body.custom_text !== undefined && body.option_index === undefined;
        if (supplied !== 1 && !navigating && !combined) return badRequest("invalid_answer", "Exactly one answer is required.");
        if ((supplied > 1 && !combined) || (navigating && supplied !== 0) || (body.step_back === true && body.step_index !== undefined)
          || (!navigating && body.draft !== undefined)) return badRequest("invalid_answer", "Exactly one answer is required.");

        if (navigating) {
          let targetStep = openCodeForm.stepIndex - 1;
          if (body.step_index !== undefined) {
            if (!Number.isInteger(body.step_index) || body.step_index < 0 || body.step_index >= openCodeForm.stepIndex) {
              return badRequest("invalid_answer", "Invalid step index to step back to.");
            }
            targetStep = body.step_index;
          }
          if (targetStep < 0) {
            return badRequest("invalid_answer", "Cannot step back from the first step.");
          }

          const draft = state.draft ? { ...state.draft, answers: { ...state.draft.answers } } : {
            formId: openCodeForm.formId,
            stepIndex: targetStep,
            answers: {},
            updatedAt: openCodeState.now(),
          };
          if (body.draft !== undefined) {
            if (typeof body.draft !== "object" || body.draft === null
              || !Array.isArray(body.draft.option_indices) || typeof body.draft.custom_text !== "string"
              || body.draft.custom_text.length > 12_000
              || body.draft.option_indices.some((index) => !Number.isInteger(index) || index < 0 || index >= openCodeForm.options.length)
              || (!parsedPrompt.multi_select && body.draft.option_indices.length > 1)
              || (parsedPrompt.custom_option_index === null && body.draft.custom_text !== "")) return badRequest("invalid_answer", "Invalid draft.");
            const selected = body.draft.option_indices.map((index) => openCodeForm.options[index]!.value);
            const custom = body.draft.custom_text;
            draft.answers[openCodeForm.fieldKey] = parsedPrompt.multi_select ? [...selected, ...(custom ? [custom] : [])] : custom || selected[0] || "";
          }
          if (JSON.stringify(draft.answers).length > 65_536) return badRequest("invalid_answer", "The form answers are too large.");
          draft.stepIndex = targetStep;
          draft.updatedAt = openCodeState.now();
          state.draft = draft;
          state.updatedAt = draft.updatedAt;
          state.revision++;
          askingEnded(body.pane_id);
          return jsonResponse({ ok: true });
        }

        let answerValue: string | string[];
        if (body.custom_text !== undefined && body.option_indices === undefined) {
          if (typeof body.custom_text !== "string") return badRequest("invalid_answer", "Custom text must be a string.");
          const text = body.custom_text.trim();
          if ((!text && !parsedPrompt.optional) || text.length > 12_000 || (text && parsedPrompt.custom_option_index === null)) return badRequest("invalid_answer", "This prompt does not accept a custom answer.");
          answerValue = parsedPrompt.multi_select ? (text ? [text] : []) : text;
        } else if (body.option_indices !== undefined) {
          if (!Array.isArray(body.option_indices)) return badRequest("invalid_answer", "Option indices must be an array.");
          if (!parsedPrompt.multi_select || (body.option_indices.length === 0 && !combined && !parsedPrompt.optional)) return badRequest("invalid_answer", "This prompt requires one or more selections.");
          const choices = [...new Set(body.option_indices)];
          if (choices.some((c) => !Number.isInteger(c) || c < 0 || c >= openCodeForm.options.length)) {
            return badRequest("invalid_answer", "An option index is outside the displayed range.");
          }
          answerValue = choices.map((i) => openCodeForm.options[i]!.value);
          if (body.custom_text !== undefined) {
            if (typeof body.custom_text !== "string" || !body.custom_text.trim() || body.custom_text.length > 12_000 || parsedPrompt.custom_option_index === null) return badRequest("invalid_answer", "This prompt does not accept a custom answer.");
            answerValue.push(body.custom_text.trim());
          }
        } else {
          const index = body.option_index;
          if (!Number.isInteger(index) || index! < 0 || index! >= openCodeForm.options.length || index === parsedPrompt.custom_option_index || parsedPrompt.multi_select) {
            return badRequest("invalid_answer", "A valid option index is required.");
          }
          answerValue = openCodeForm.options[index!]!.value;
        }

        const draft = state.draft ? { ...state.draft, answers: { ...state.draft.answers } } : {
          formId: openCodeForm.formId,
          stepIndex: openCodeForm.stepIndex,
          answers: {},
          updatedAt: openCodeState.now(),
        };
        draft.answers[openCodeForm.fieldKey] = answerValue;
        if (JSON.stringify(draft.answers).length > 65_536) return badRequest("invalid_answer", "The form answers are too large.");
        draft.updatedAt = openCodeState.now();
        state.updatedAt = draft.updatedAt;

        const isLastStep = openCodeForm.stepIndex >= openCodeForm.totalSteps - 1;
        if (!isLastStep) {
          draft.stepIndex += 1;
          state.draft = draft;
          state.revision++;
          askingEnded(body.pane_id);
          return jsonResponse({ ok: true });
        }

        const config = (await openCodeService(options.openCodeStateDir, deadline, { onWindows: true }))?.config ?? null;
        if (!config) {
          return jsonResponse({ error: { code: "service_unavailable", message: "OpenCode service is not available." } }, 502);
        }

        if (!(await stillBound())) return promptChanged();
        const replyResult = await replyOpenCodeForm(config, openCodeForm.sessionID, openCodeForm.formId, draft.answers, deadline);
        if (replyResult.ok) {
          delivered = true;
          way = "native";
          const sent = chatSent.get(body.pane_id)?.commands.at(-1);
          if (sent?.dialogId === prompt.id) noteCommandEvidence(body.pane_id, sent.id, { kind: "native", at: Date.now() });
          // Only clean up this asking: another form/session may already have replaced it.
          if (openCodeState.entries.get(body.pane_id) === state && state.revision === openCodeForm.revision) {
            state.draft = undefined;
            state.form = null;
            state.listed = null;
            state.revision++;
            formsAnswered.set(body.pane_id, Date.now());
            if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
            if (askings.get(body.pane_id) === asking) askingEnded(body.pane_id);
          }
          return jsonResponse({ ok: true });
        }
        if (replyResult.status === 0) return jsonResponse({ error: { code: "reply_unconfirmed", message: "OpenCode may have received your answer, but its reply did not arrive. Check the question before sending again." } }, 504);
        if (!current()) return promptChanged();
        if (replyResult.status === 409) {
          state.draft = undefined;
          state.form = null;
          state.listed = null;
          state.revision++;
          return jsonResponse({ error: { code: "prompt_changed", message: "The form has already been settled." } }, 409);
        }
        return jsonResponse({ error: { code: "reply_failed", message: `Failed to reply to OpenCode form (HTTP ${replyResult.status}).` } }, 502);
      }

      /**
       * Once a key may have been pressed (its write went out, or its reply never came) the move ends this asking on
       * whatever exit it takes, so an unchanged drawing reads as a new asking; a failure proven to come before the write
       * (cancelled, unreachable) does not.
       */
      const moveKeys = (active: () => boolean) => {
        let pressed = false;
        const left = (): number => Math.max(0, deadlineAt - Date.now());
        return {
          pressed: (): boolean => pressed,
          send: async (key: string, from: (shown: ParsedPrompt) => boolean): Promise<void> => {
            const inTime = (): boolean => active() && Date.now() < deadlineAt;
            if (!inTime()) throw new MoveLapsed();
            const { sending } = await verifyThenSend(deadline, deadlineAt, deadlineAt,
              (shown) => shown !== null && from(shown) && inTime(),
              () => ({ sending: paneSendKeys(body.pane_id, [key], undefined, inTime) })).catch((error: unknown) => {
              throw error instanceof KeyRefused ? new MoveLapsed() : error;
            });
            sending.catch(() => undefined);
            let sent: boolean;
            try { sent = await Promise.race([sending.then(() => true), Bun.sleep(left()).then(() => false)]); }
            catch (error) {
              const before = error instanceof HerdrError && (error.code === "cancelled" || error.code === "connect_failed");
              if (!before) pressed = true;
              throw error instanceof HerdrError && error.code === "cancelled" ? new MoveLapsed() : error;
            }
            pressed = true;
            if (!sent) throw new MoveLapsed();
          },
          read: async (): Promise<Awaited<ReturnType<typeof readPrompt>> | null> => {
            if (!active()) return null;
            const reading = readPrompt(body.pane_id, options.codexHome, options.openCodeStateDir, openCodeState, deadline);
            reading.catch(() => undefined);
            const live = await Promise.race([reading, Bun.sleep(left()).then(() => null)]);
            return live && active() ? live : null;
          },
        };
      };

      if (parsedPrompt?.nativeSteps && (body.step_back === true || body.step_next === true || body.step_index !== undefined)) {
        const target = nativeStepTarget(parsedPrompt, body);
        if (typeof target === "string") return badRequest("invalid_answer", target);
        if (!draftKept(parsedPrompt, body.draft)) return badRequest("invalid_answer", "Submit or clear edits before switching questions.");
        const prior = askings.get(body.pane_id);
        if (!prior || prior.content === null) return promptChanged();
        const asking: Asking = { content: prior.content, n: askingCount += 1, queued: prior.queued };
        askings.set(body.pane_id, asking);
        const active = (): boolean => !deadline.aborted && askings.get(body.pane_id) === asking && asking.content !== null;
        answersUnderWay.add(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        const keys = moveKeys(active);
        let done = false;
        try {
          const moved = await navigateNativeSteps(parsedPrompt, target, {
            deadline: deadlineAt, active,
            send: keys.send,
            read: async () => {
              const live = await keys.read();
              const shown = live && !live.inputUnverified && live.prompt ? parsedByPublicPrompt.get(live.prompt) ?? null : null;
              return shown?.agent === parsedPrompt.agent ? shown : null;
            },
          });
          if (!moved) return promptChanged();
          done = true;
          if (askings.get(body.pane_id) === asking) asking.content = moved.id;
          return jsonResponse({ ok: true });
        } catch (error) {
          if (error instanceof KeyRefused) return promptChanged();
          throw error;
        } finally {
          answersUnderWay.delete(body.pane_id);
          answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
          if (!done && keys.pressed()) askingEnded(body.pane_id);
        }
      }

      if (parsedPrompt?.responder === "pi-ask-user" && parsedPrompt.piAskUser) {
        const { response, answered } = await answerPiAskUser(body.pane_id, parsedPrompt, body, deadline);
        if (response.ok) askingEnded(body.pane_id);
        if (answered) {
          delivered = true;
          way = "native";
          const sent = chatSent.get(body.pane_id)?.commands.at(-1);
          if (sent?.dialogId === prompt.id) noteCommandEvidence(body.pane_id, sent.id, { kind: "native", at: Date.now() });
          formsAnswered.set(body.pane_id, Date.now());
          if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
        }
        return response;
      }

      if (body.step_back === true || body.step_next === true || body.step_index !== undefined) {
        // pi's tabs, or Claude's question tabs and their review (#2465): ←/→, each move seen before the next
        const claude = parsedPrompt?.claudeTabs !== undefined;
        const native = parsedPrompt?.piAskForm ?? parsedPrompt?.claudeTabs;
        if (!parsedPrompt || !native || [body.step_back === true, body.step_next === true, body.step_index !== undefined].filter(Boolean).length !== 1
          || body.option_index !== undefined || body.option_indices !== undefined || body.custom_text !== undefined) {
          return badRequest("invalid_answer", "Exactly one supported navigation action is required.");
        }
        const target = body.step_index ?? native.index + (body.step_next === true ? 1 : -1);
        if (!Number.isInteger(target) || target < 0 || target === native.index || !parsedPrompt.steps?.[target]?.can_navigate) {
          return badRequest("invalid_answer", "Invalid question to navigate to.");
        }
        // Do not drop web-only edits or turn a navigation request into an implicit answer.
        if (body.draft !== undefined) {
          const draft = body.draft;
          const expected = parsedPrompt.multi_select ? parsedPrompt.default_option_indices ?? []
            : parsedPrompt.default_option_index !== undefined && parsedPrompt.default_option_index !== null ? [parsedPrompt.default_option_index] : [];
          if (!draft || !Array.isArray(draft.option_indices) || typeof draft.custom_text !== "string"
            || draft.option_indices.some(index => !Number.isInteger(index))
            || JSON.stringify([...draft.option_indices].sort((a, b) => a - b)) !== JSON.stringify(expected)
            || draft.custom_text !== (parsedPrompt.default_custom_text ?? "")) {
            return badRequest("invalid_answer", "Submit or clear edits before switching questions.");
          }
        }
        const prior = askings.get(body.pane_id);
        if (!prior || prior.content === null) return promptChanged();
        const asking: Asking = { content: prior.content, n: askingCount += 1, queued: prior.queued };
        askings.set(body.pane_id, asking);
        const active = (): boolean => !deadline.aborted && askings.get(body.pane_id) === asking && asking.content !== null;
        answersUnderWay.add(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        const keys = moveKeys(active);
        let done = false;
        try {
          const moved = await navigatePiAsk(parsedPrompt, target, {
            deadline: deadlineAt, active,
            send: keys.send,
            read: async () => {
              const live = await keys.read();
              if (!live) return null;
              const ours = claude ? live.agent === "claude"
                : live.agent === "pi" && (live.status === "blocked" || live.status === "idle" && parsedPrompt.responder.startsWith("pi-questionnaire-"));
              return !live.inputUnverified && ours && live.prompt ? parsedByPublicPrompt.get(live.prompt) ?? null : null;
            },
          }, claude ? (shown) => shown.claudeTabs : undefined);
          if (!moved) return promptChanged();
          done = true;
          if (askings.get(body.pane_id) === asking) asking.content = moved.id;
          return jsonResponse({ ok: true });
        } catch (error) {
          if (error instanceof KeyRefused) return promptChanged();
          throw error;
        } finally {
          answersUnderWay.delete(body.pane_id);
          answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
          if (!done && keys.pressed()) askingEnded(body.pane_id);
        }
      }

      // Yes or No on a card built on a held hook request is that request's answer, with no key. Any other option goes as
      // keys to the dialog on the screen, only where it shows that request's command, whole, and no other's
      const decision = heldId === null || body.option_index === undefined || body.custom_text !== undefined ? null
        : options.approvals!.decision(body.pane_id, heldId, prompt.options[body.option_index]?.label ?? "");
      if (decision !== null && parsedPrompt !== undefined) {
        // the request left since the read: no key either, as the dialog now on the screen may be another command's
        if (!options.approvals!.answer(body.pane_id, approvalDialog(prompt)!, heldId!, decision)) return promptChanged();
        delivered = true;
        way = "native";
        askingEnded(body.pane_id);
        form.still = parsedPrompt.responder === "claude-approval" ? claudeStepStill(parsedPrompt) : sameContent(contentId(prompt));
        return jsonResponse({ ok: true });
      }
      if (heldId !== null && !options.approvals!.showsOnly(body.pane_id, approvalDialog(prompt)!, heldId)) return promptChanged();
      // a Codex question its own server waits on too: a pick of an option goes as data, by the request's id, with no key;
      // one answered meanwhile takes no key either (codex-question.ts)
      if (request.signal.aborted) return promptChanged();
      const served = agent === "codex" && parsedPrompt !== undefined ? answerServed(body.pane_id, parsedPrompt, body) : null;
      if (served === "gone") return promptChanged();
      if (served === "sent") {
        delivered = true;
        way = "native";
        askingEnded(body.pane_id);
        form.still = sameContent(contentId(prompt));
        return jsonResponse({ ok: true });
      }

      let steps: AnswerStep[];
      try {
        steps = answerKeys(prompt, body);
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        throw error;
      }
      // The asking this answer is for, held to its last key: once anything says it ended (the
      // agent back at work), no key of this answer goes out any more, whatever the screen shows.
      const asking = askings.get(body.pane_id)!;
      const asks = (): boolean => askings.get(body.pane_id) === asking && asking.content !== null;
      let target = prompt;
      let lastSeen: string | undefined;
      const opensQueue = parsedByPublicPrompt.get(prompt)?.responder === "codex-queued-question";
      const opensOmo = parsedByPublicPrompt.get(prompt)?.responder === "omo-pending";
      let answered = false;
      let committed = false;
      let queueOpened = false;
      answersUnderWay.add(body.pane_id);
      answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
      try {
        if (request.signal.aborted) return promptChanged();
        if (opensQueue) {
          const opened = await openQueuedQuestion(body.pane_id, parsedByPublicPrompt.get(prompt)!, () => request.signal.aborted, (open) => { queueOpened = open; });
          // a queue it could not answer in it has closed again itself, or never opened: a
          // queue another client opened meanwhile is that client's to close
          if (!opened) return promptChanged();
          if (!asks()) return promptChanged();
          target = opened;
        }
        if (opensOmo) {
          // Alt+Up opens the form even with whitespace in the composer; no draft is submitted.
          // A remapped shortcut or a different question fails closed before any answer text.
          await paneSendKeys(body.pane_id, [KEY.openQueue]);
          const deadline = Date.now() + SETTLE_MS;
          let opened: InteractivePrompt | null = null;
          while (Date.now() < deadline) {
            if (!asks() || request.signal.aborted) return promptChanged();
            const left = deadline - Date.now();
            const read = await Promise.race([readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir), Bun.sleep(left).then(() => null)]);
            if (!read || Date.now() > deadline) return promptChanged();
            const parsed = read.prompt && parsedByPublicPrompt.get(read.prompt);
            if (parsed?.responder === "omo-question") {
              // Opening a form changes its drawing, but not the call or question it answers.
              const pending = parsedByPublicPrompt.get(prompt)!;
              if (!pending.omoQuestion || parsed.omoQuestion?.call !== pending.omoQuestion.call
                || parsed.omoQuestion.index !== pending.omoQuestion.index
                || parsed.question !== pending.question || parsed.multi_select !== pending.multi_select
                || JSON.stringify(parsed.options) !== JSON.stringify(pending.options)) return promptChanged();
              opened = read.prompt;
              break;
            }
            await Bun.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
          }
          if (!opened || !asks()) return promptChanged();
          target = opened;
        }
        if (target !== prompt) steps = answerKeys(target, body);
        const parsed = parsedByPublicPrompt.get(target)!;
        const responder = parsed.responder;
        const reader = registry.readerFor(responder);
        const interaction = body.custom_text === undefined ? reader?.interaction?.(parsed) : undefined;
        const checkBeforeText = responder === "fallback-gjc-menu" || responder === "pi-ask-question"
          || responder === "pi-questionnaire-question" || responder === "agy-question";
        const editorAnswer = body.custom_text !== undefined && (checkBeforeText || responder === "dsh-question"
          || responder === "claude-question" || responder === "omp-question" || responder === "omo-question" || responder === "omo-review" || responder === "hermes-question"
          || responder === "hermes-input" || responder === "opencode-v1-question")
          ? { prompt: parsed, text: body.custom_text.trim() } : undefined;
        // where the moves sent so far leave the cursor (↑ stops at the first row: omoWalk)
        let cursor = parsed.selectedIndex;
        // Claude's unnumbered rows and pi's models are read with no number to aim at: looked at
        // again before the Enter even when it needs no move. So is Claude's model list, picked
        // with a letter: typed after the list has gone, it would stand in the agent's own prompt
        let moved = reader !== undefined && reader.reread !== "none";
        // Claude's and Codex's model lists: a window on a list, picked with a letter; Claude's effort
        // slider the same way, its levels side by side
        const list = reader !== undefined && reader.list !== "none";
        // ←/→ move the slider; anywhere else they are a menu's own keys (Claude's question tabs)
        const sideways = reader?.list === "slider";
        let seen: ParsedPrompt | null = null;
        const looked = (shown: ParsedPrompt | null): void => { seen = shown; lastSeen = shown?.id; };
        const aimed = (shown: ParsedPrompt | null, screen: string): boolean => {
          if (interaction) return shown?.responder === responder && interaction.matches(screen);
          if ((responder === "pi-question" || responder === "pi-confirm") && cursor !== 0) {
            const dialog = parsePiDialog(screen, true);
            return dialog?.id === parsed.id && dialog.selectedIndex === cursor && promptTailIsActive(dialog, screen);
          }
          if (responder === "dsh-question" && cursor === parsed.customMenuIndex) return dshFreeTextRow(screen, parsed, "") === "typed";
          if (shown === null || !(responder === "agy-question" ? agySameQuestion(shown, parsed) : shown.id === parsed.id)) return false;
          return shown.selectedIndex === cursor && ticked(shown)
            && (responder !== "pi-questionnaire-question" || shown.piQuestionnaireInput === undefined);
        };
        let matchedScreen: string | null = null;
        const onRow = async (): Promise<boolean> => {
          const deadline = Date.now() + SETTLE_MS;
          for (;;) {
            if (!asks() || request.signal.aborted) return false;
            const left = deadline - Date.now();
            if (left <= 0) return false;
            const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir,
              openCodeState, undefined, agent === "gjc" ? (parsed.record !== undefined ? "record" : "screen") : false);
            reading.catch(() => undefined);
            const read = await Promise.race([reading, Bun.sleep(left).then(() => null)]);
            if (!read || Date.now() > deadline) return false;
            const shown = read.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
            if (!read.inputUnverified && asks() && aimed(shown, read.screen ?? "")) { looked(shown); matchedScreen = read.screen ?? ""; return true; }
            await Bun.sleep(50);
          }
        };
        const sameQuestion = (shown: ParsedPrompt | null, screen: string, onCursor: boolean, settled: ParsedPrompt | null): boolean => {
          if (interaction) return shown?.responder === responder && interaction.matches(screen);
          if (responder === "dsh-question" && cursor === parsed.customMenuIndex) {
            return dshFreeTextRow(screen, parsed, "") === "typed";
          }
          if (responder === "pi-question" || responder === "pi-confirm") {
            const dialog = parsePiDialog(screen, true);
            return dialog?.id === parsed.id && (!onCursor || dialog.selectedIndex === cursor);
          }
          if (responder.startsWith("fallback")) {
            if (!asks()) return false;
            const drawn = parsedByPublicPrompt.get(parseFallbackPrompt(agent, screen));
            // a card with its record's command is that request's: the screen must still show it, with nothing else changed
            const record = parsed.record === undefined ? undefined : recordFor(agent);
            const card = drawn && record ? withRecord(drawn, parsed.record!, screen, record) : drawn;
            return card?.id === parsed.id
              && (parsed.gjcCall === undefined || shown?.gjcCall === parsed.gjcCall)
              && (!onCursor || card.selectedIndex === cursor);
          }
          if (shown === null || !(responder === "agy-question" ? agySameQuestion(shown, parsed) : shown.id === parsed.id)) return false;
          return shown.question === parsed.question && shown.ompCall === parsed.ompCall
            && shown.nativeSteps?.index === parsed.nativeSteps?.index
            && (!onCursor || (shown.selectedIndex === cursor && ticked(shown) && (settled === null || (settled.selectedIndex === cursor && ticked(settled)))));
        };
        let agyWriteInOpened = false;
        const togglesInPlace = (): boolean =>
          (responder === "hermes-question" && body.option_indices !== undefined)
          || (responder === "agy-question" && parsed.multi_select && !agyWriteInOpened)
          || (responder === "dsh-question" && body.option_indices !== undefined);
        const ticks = new Set(parsed.checkedOptionIndices);
        function ticked(shown: ParsedPrompt): boolean {
          return !togglesInPlace() || (shown.checkedOptionIndices.length === ticks.size && shown.checkedOptionIndices.every((index) => ticks.has(index)));
        }
        const inlineEditorMatches = (shown: ParsedPrompt | null, screen: string, draft: string): boolean => {
          switch (responder) {
            case "pi-questionnaire-question":
              return shown?.id === parsed.id && shown.selectedIndex === parsed.customMenuIndex && piQuestionnaireInputMatches(shown, draft);
            case "pi-ask-question":
              return shown?.id === parsed.id && shown.selectedIndex === parsed.customMenuIndex && shown.piAskTyping === true && shown.piAskDraft === draft;
            case "agy-question":
              return agyCustomEditorMatches(screen, parsed, ticks, draft);
            case "fallback-gjc-menu":
              return gjcCustomEditorMatches(screen, parsed, draft);
            default:
              return false;
          }
        };
        const sendStep = async (step: AnswerStep, move: boolean, more: boolean): Promise<void> => {
          const write = async (): Promise<void> => {
            const first = !move && !committed;
            if (!move) committed = true;
            // asked again right before herdr writes: a question known to have ended since the last read takes no committing
            // key (a move keeps its own cancellation boundaries)
            const asked = (): boolean => asks() && !request.signal.aborted
              && (parsed.gjcCall === undefined || gjcCallStillOpenInFile(parsed.gjcCall));
            const guard = move ? undefined : asked;
            try {
              if (step.keys) await paneSendKeys(body.pane_id, step.keys, undefined, guard);
              else if (step.text !== undefined) await paneSendText(body.pane_id, step.text, undefined, guard);
            } catch (error) {
              // herdr was never reached, or the write was cancelled, so nothing was pressed: the card is still to be answered
              if (first && error instanceof HerdrError && (error.code === "connect_failed" || error.code === "cancelled")) committed = false;
              // the question ended while the write was on its way: nothing was pressed, and the card has changed
              if (!move && error instanceof HerdrError && error.code === "cancelled" && !asked()) throw new KeyRefused();
              throw error;
            }
          };
          const look = agent === "pi" ? deadline : AbortSignal.timeout(SETTLE_MS);
          const guardUntil = agent === "pi" ? null : Date.now() + SETTLE_MS;
          const lettaTyping = committed && responder === "letta-model" && body.custom_text !== undefined;
          const claudeDown = responder === "claude-question" && parsed.multi_select && step.keys?.[0] === KEY.down;
          const gjcEditorPaste = committed && !customTyped && responder === "fallback-gjc-menu" && step.text !== undefined && parsed.gjcCall !== undefined;
          const typedEditor = customTyped && step.keys?.length === 1 && (step.keys[0] === KEY.enter || claudeDown) ? editorAnswer : undefined;
          if (!committed || togglesInPlace() || lettaTyping || typedEditor || gjcEditorPaste) {
            const onCursor = !move && (step.keys?.every((key) => key === KEY.enter || key === KEY.space) ?? false);
            const { written } = await verifyThenSend(look, guardUntil, Date.now() + SETTLE_MS,
              (shown, screen, settled) => {
                if (gjcEditorPaste) {
                  if (!asks() || request.signal.aborted) return false;
                  return inlineEditorMatches(shown, screen, "");
                }
                if (typedEditor) {
                  if (!asks() || request.signal.aborted) return false;
                  if (checkBeforeText) return inlineEditorMatches(shown, screen, typedEditor.text);
                  if (responder === "dsh-question") return dshFreeTextRow(screen, parsed, dshTypedText(typedEditor.text)) === "typed";
                  if (responder === "omp-question") return ompCustomEditorMatches(screen, typedEditor);
                  if (responder === "opencode-v1-question") return openCodeV1CustomEditorMatches(screen, typedEditor);
                  return shown?.agent === parsed.agent && shown.customEditorMatches?.(typedEditor, claudeDown ? "editor" : "submit") === true;
                }
                return lettaTyping ? lettaSearchShown(shown, parsed, lettaSearch) : sameQuestion(shown, screen, onCursor, settled);
              }, () => ({ written: write() }),
              typedEditor || gjcEditorPaste ? "editor" : interaction !== undefined || responder === "pi-question" || responder === "pi-confirm" || responder.startsWith("fallback"));
            await written;
          } else {
            const guarding = guardKey(body.pane_id, agent, look);
            guarding.catch(() => undefined);
            const guarded = guardUntil === null ? await guarding.then(() => true)
              : await Promise.race([guarding.then(() => true), Bun.sleep(Math.max(0, guardUntil - Date.now())).then(() => false)]);
            if (!guarded) throw new KeyRefused();
            await write();
          }
          if (more) await Bun.sleep(30);
        };
        let customTyped = false;
        let lettaSearch = parsed.lettaSearch ?? "";
        const customEditorReady = async (draft: string): Promise<boolean> => {
          const deadline = Date.now() + SETTLE_MS;
          if (responder === "pi-ask-question" || responder === "pi-questionnaire-question") {
            while (asks() && !request.signal.aborted && Date.now() < deadline) {
              const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir);
              const read = await Promise.race([reading, Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
              if (!read || read.inputUnverified || !asks() || request.signal.aborted || Date.now() >= deadline) return false;
              const shown = read.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
              if (inlineEditorMatches(shown, read.screen ?? "", draft)) return true;
              // the same editor, still empty: the paste has not been drawn yet
              if (draft === "" || !inlineEditorMatches(shown, read.screen ?? "", "")) return false;
              await Bun.sleep(50);
            }
            return false;
          }
          if (responder === "letta-model") {
            // Letta's picker, its search as the keys so far left it (the line drops trailing spaces): a closed
            // picker would hand the next key to Letta's input
            while (asks() && !request.signal.aborted && Date.now() < deadline) {
              const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir);
              reading.catch(() => undefined);
              const read = await Promise.race([reading, Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
              const shown = read?.prompt ? parsedByPublicPrompt.get(read.prompt) : null;
              if (read && !read.inputUnverified && lettaSearchShown(shown, parsed, draft)) {
                return asks() && !request.signal.aborted && Date.now() < deadline;
              }
              await Bun.sleep(50);
            }
            return false;
          }
          if (responder === "dsh-question") {
            // the row holds this answer's text and nothing else: words typed there meanwhile would go out with the Enter,
            // and a question answered or cancelled meanwhile would hand it to dsh-tui's own input box
            const typed = dshTypedText(draft);
            while (asks() && !request.signal.aborted && Date.now() < deadline) {
              const read = await Promise.race([
                paneRead({ paneId: body.pane_id, source: "detection" }),
                Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
              ]);
              if (!read || !asks() || request.signal.aborted || Date.now() >= deadline) return false;
              const row = dshFreeTextRow(read.text, parsed, typed);
              if (row !== "typing") return row === "typed";
              await Bun.sleep(50);
            }
            return false;
          }
          if (responder === "agy-question") {
            while (asks() && !request.signal.aborted && Date.now() < deadline) {
              const read = await Promise.race([
                paneRead({ paneId: body.pane_id, source: "detection" }),
                Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
              ]);
              if (!read || !asks() || request.signal.aborted || Date.now() >= deadline) return false;
              if (inlineEditorMatches(null, read.text, draft)) return true;
              if (agyCustomEditorMatches(read.text, parsed, ticks, draft, true)) {
                await Bun.sleep(50);
                continue;
              }
              const before = parseAgyQuestion(read.text);
              if (!agySameQuestion(before, parsed) || before.selectedIndex !== parsed.customMenuIndex || !ticked(before)) return false;
              await Bun.sleep(50);
            }
            return false;
          }
          while (asks() && !request.signal.aborted && Date.now() < deadline) {
            const read = await Promise.race([
              paneRead({ paneId: body.pane_id, source: "detection" }),
              Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
            ]);
            if (!read || !asks() || request.signal.aborted || Date.now() >= deadline) return false;
            if (inlineEditorMatches(null, read.text, draft)) return true;
            // the same editor, still empty: the paste has not been drawn yet
            const waiting = draft !== "" && inlineEditorMatches(null, read.text, "");
            const before = waiting ? undefined : parsedByPublicPrompt.get(parseFallbackPrompt("gjc", read.text));
            if (!waiting && (before?.id !== parsed.id || before.selectedIndex !== parsed.customMenuIndex)) return false;
            await Bun.sleep(50);
          }
          return false;
        };
        if (interaction) {
          const result = await executeInteractionPlan(interaction, body.option_index!, {
            rereadMoves: list || reader?.reread === "each-move",
            active: asks,
            cancelled: () => request.signal.aborted,
            read: async () => await onRow() ? matchedScreen : null,
            send: (step, commit) => sendStep(step, !commit, !commit),
          });
          if (result === "prompt_changed") return promptChanged();
        } else {
          let walked = false;
          for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index]!;
            const move = step.keys?.every((key) => key === KEY.up || key === KEY.down || (sideways && (key === KEY.left || key === KEY.right))) ?? false;
            if (!asks()) return promptChanged();
            // Wait for an editor opened by earlier keys before sending text. dsh draws typed text
            // incrementally; it gets the same settling wait before the final verify-and-send.
            if (editorAnswer && committed && !customTyped && checkBeforeText && (responder !== "agy-question" || agyWriteInOpened)
              && !(await customEditorReady(""))) return promptChanged();
            // the paste can show a moment after its write: wait, bounded, for the editor to hold it before the fresh check of
            // the Enter (gjc's menu and agy redraw late; pi's readers look once)
            if (editorAnswer && customTyped && (responder === "dsh-question" || checkBeforeText) && !(await customEditorReady(editorAnswer.text))) return promptChanged();
            if (responder === "letta-model" && body.custom_text !== undefined && committed && !(await customEditorReady(lettaSearch))) return promptChanged();
            // GJC's selector can close under the answer: its composer must not take the moves.
            if (move && walked && (list || reader?.reread === "each-move" || responder === "fallback-gjc-menu") && !(await onRow())) return promptChanged();
            if (!move && (!committed || togglesInPlace())) {
              if ((moved || (togglesInPlace() && committed)) && !(await onRow())) return promptChanged();
              if (request.signal.aborted) return promptChanged();
            }
            // herdr may press the key and lose its reply; a possibly pressed key ends the asking.
            const key: AnswerStep | null = step.pick ? (seen as ParsedPrompt | null)?.rowKey ?? null : step;
            if (key === null) return promptChanged();
            await sendStep(key, move, index < steps.length - 1);
            if (responder === "agy-question" && body.custom_text !== undefined && !move && key.keys?.includes(KEY.enter)) agyWriteInOpened = true;
            // From here the typed editor is verified after the next key's look, in the same turn as its write.
            if (key.text !== undefined) {
              customTyped = true;
              lettaSearch += key.text;
            }
            for (const pressed of key.keys ?? []) if (pressed === KEY.backspace) lettaSearch = lettaSearch.slice(0, -1);
            if (move) {
              moved = true;
              walked = true;
              for (const key of step.keys!) cursor = key === KEY.down || key === KEY.right ? cursor + 1 : Math.max(0, cursor - 1);
            } else if (togglesInPlace() && step.keys?.length === 1 && step.keys[0] === KEY.space) {
              if (!ticks.delete(cursor)) ticks.add(cursor);
            }
          }
        }
        answered = true;
        delivered = true;
        way = readFromRecord(parsed) ? "record" : "screen";
        // a card showing its record's command: whether that request closed is looked at after the pane's turn
        if (committed && parsedPrompt?.record !== undefined) form.record = { agent, id: parsedPrompt.record.id };
        const sent = chatSent.get(body.pane_id)?.commands.at(-1);
        if (committed && sent?.dialogId === prompt.id && sent.form?.dialog === parsed.responder
          && body.option_index !== parsed.rejectWithEscapeIndex) noteCommandEvidence(body.pane_id, sent.id, { kind: "dialog", at: Date.now() });
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        if (error instanceof KeyRefused) return promptChanged();
        throw error;
      } finally {
        answersUnderWay.delete(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        if (queueOpened && !answered) await closeOpenQuestion(body.pane_id).catch(() => undefined);
        if (committed) askingEnded(body.pane_id);
        const answeredCard = parsedByPublicPrompt.get(target);
        if (committed && (answeredCard?.responder === "letta-model" || answeredCard?.responder === "letta-effort") && body.option_index !== undefined
          && answeredCard.optionSteps?.[body.option_index]?.at(-1)?.keys?.[0] === KEY.enter) {
          const asking = askings.get(body.pane_id);
          if (asking) asking.picked = lettaPick(answeredCard);
        }
        if (committed && parsedByPublicPrompt.get(target)?.responder === "claude-held") heldCandidates.delete(body.pane_id);
      }
      // answered from the chat, the queue closes again: the next question waits collapsed, and
      // the main prompt (where a message typed in the chat goes) has the input back
      if (parsedByPublicPrompt.get(target)?.responder === "codex-async-question") {
        queueFronts.delete(body.pane_id);
        await closeQueue(body.pane_id, contentId(target)!);
      }
      const responder = parsedByPublicPrompt.get(target)?.responder;
      if (responder === "omo-question" || responder === "omo-review" || responder === "omo-typing" || responder === "omo-pending"
        || responder === "pi-ask-question" || responder === "pi-ask-submit"
        || responder === "pi-questionnaire-question" || responder === "pi-questionnaire-submit") {
        formsAnswered.set(body.pane_id, Date.now());
        if (formsAnswered.size > 64) formsAnswered.delete(formsAnswered.keys().next().value!);
      }
      // A model list closes, or opens its next list, a moment after its key: the same wait, so
      // the card's read right after the answer does not get the list just answered once more
      // Claude draws its next tab, or its review, a moment after the key: the same wait, by what the
      // step asks, whether or not its tabs are steps (#2465; order by @jpcarranza94 in #2503). Its
      // other dialogs close a moment after the key too, and get the same wait
      if (responder === "claude-question" || responder === "claude-submit"
        || responder === "claude-approval" || responder === "claude-plan" || responder === "claude-confirm") form.still = claudeStepStill(parsedByPublicPrompt.get(target)!);
      else if (target.steps) form.still = sameContent(contentId(target));
      else if (responder === "claude-model" || responder === "claude-effort" || responder === "codex-model") form.still = sameContent(lastSeen ?? contentId(target));
      else if (form.record !== undefined) form.still = sameContent(contentId(target));
      return jsonResponse({ ok: true });
    });
    // the wait for the form's next step only reads the pane: after the pane's turn, so a message
    // queued for it meanwhile is not held up behind the polls
    // a key is no proof its request ended: the record says whether it did (never a reason to send it again)
    const closing = form.record === undefined ? null : recordSettled(body.pane_id, form.record.agent, form.record.id);
    if (form.still !== undefined) await formMovedOn(body.pane_id, form.still, options.codexHome, options.openCodeStateDir);
    if (closing !== null) log.record = await closing;
    endAnswer(response.ok && delivered ? way : null);
    for (const told of answering.splice(0)) told(waitedOn && response.ok && delivered);
    await logAnswer(log, response);
    return response;
  } catch (error) {
    // keys that reached the pane are an answer even when something after them failed
    endAnswer(delivered ? way : null);
    for (const told of answering.splice(0)) told(waitedOn && delivered);
    const response = errorResponse(error);
    if (answerLog !== null) await logAnswer(answerLog, response);
    return response;
  }
}

/** One line per answer that got as far as the pane: the pane, whether the card's prompt still stood, and the
 * refusal's own code (prompt_changed, invalid_answer, agent_blocked, a herdr error...). Never the answer. The pane
 * id is the client's until the snapshot has checked it, so it is logged as a JSON string: one field, whatever it holds. */
async function logAnswer(log: { paneId: string; matched: boolean; record?: RecordOutcome }, response: Response): Promise<void> {
  const outcome = response.ok ? "ok" : ((await response.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? `status_${response.status}`;
  // quoted as JSON: a space or a newline in the client's id cannot pass for a field of the line
  const pane = JSON.stringify(log.paneId.slice(0, 80));
  console.log(`[prompt/answer] pane=${pane} prompt_matched=${log.matched} outcome=${outcome}${log.record === undefined ? "" : ` record=${log.record}`}`);
}
