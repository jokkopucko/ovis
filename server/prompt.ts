import { createHash, randomBytes } from "node:crypto";
import type { HerdrPane, InteractivePrompt, PanePromptResponse, PromptAnswer, SessionSnapshot, SlashCommand } from "../shared/protocol.ts";
import { builtinCommands, cachedPaneCommands } from "./commands.ts";
import { piRecordText } from "./pi-delivery.ts";
import { agentProcesses, ompTranscriptPath, paneRunsOmo, readCommandTranscript } from "./conversation.ts";
import { ConversationNotStarted } from "./conversation-shared.ts";
import { agentProcessInFront } from "./agent-process.ts";
import { resolveAgent } from "./pane-context.ts";
import { processAlive, processStartedAt, processStartUpperBoundAsync } from "./process-start.ts";
import { commandInvocations, commandOutcome, CommandReservations, dialogSettlingScreen, ownsCommandDialog, WINDOW_MS as COMMAND_WINDOW_MS, type CommandSend } from "./outcome.ts";
import { codexTranscriptPath, paneCodexHomePlaced, unansweredCodexQuestions } from "./codex.ts";
import { HerdrError, paneProcessInfo, paneRead, paneScrollInfo, paneSendKeys, paneSendText, type ProcessInfo } from "./herdr/client.ts";
import { isPiProcess, piTranscriptPath } from "./pi.ts";
import { heldOmoProcess } from "./omo.ts";
import { OmoAskReader, ompAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { ompCallPrompt, ompMarkdownPrompt, ompOpenCall, ompStepPrompt } from "./omp-ask.ts";
import { answerPiAskUser, bindPiAsk, piAskActivity, piAskUserPrompt } from "./pi-ask-bridge.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";
import { claudePlanFile } from "./claude-plan.ts";
import { listPendingQuestionForms, openCodeService, replyOpenCodeForm } from "./opencode-service.ts";
import { opencodeSessionId } from "./opencode.ts";
import { registry } from "./dialogs/registry.ts";
import { ANSI_RE, type AnswerStep, KEY, type OmoAsk, type ParsedPrompt, type PromptDraft, cleanLine, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, own, parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import { executeInteractionPlan } from "./dialogs/interaction-plan.ts";
import { liveScreen, parsePrompt, promptTailIsActive } from "./dialogs/live.ts";
import { sameText } from "./dialogs/omo.ts";
import { OMP_REVIEW_HINT_RE, OMP_TABS_HINT_RE } from "./dialogs/omp.ts";
import { INVISIBLE_CHAR_RE } from "./dialogs/claude.ts";
import { parsePiDialog } from "./dialogs/pi.ts";
import { pendingPiQuestionnaires } from "./pi-questionnaire.ts";
import { isPiQuestionnaireScreen, parsePiQuestionnaire, piQuestionnaireInputMatches, piQuestionnaireOf } from "./dialogs/pi-questionnaire.ts";
import { parsePiAsk } from "./dialogs/pi-ask.ts";
import { navigatePiAsk } from "./dialogs/pi-ask-navigate.ts";
import { draftKept, nativeStepTarget, navigateNativeSteps } from "./dialogs/step-navigate.ts";
import { gjcCustomEditorMatches, parseFallbackPrompt } from "./dialogs/fallback.ts";
import { SUGGESTION_READ_MS, claudeHeldIsGrey, claudeInputBoxContent, claudeInputDraft, claudeRestoredDraft, parseClaudeSuggestion, viewportShowsLive } from "./claude-input.ts";
import { OMO_FORM_RE, omoAskOf, omoAsksFor } from "./omo-questions.ts";
import { codexQueuedPrompt, queuedQuestionCount, type QueueFront } from "./codex-queue.ts";
import { OpenCodePromptState } from "./opencode-prompt.ts";
export { removedInvisible } from "./dialogs/claude.ts";
export { INVISIBLE_CHAR_RE } from "./dialogs/claude.ts";
export type { OmoAsk } from "./dialogs/shared.ts";
export { parseFallbackPrompt } from "./dialogs/fallback.ts";
export { CLAUDE_CLEAR_INPUT_KEYS, INPUT_BOX_SHOWN_CHARS, claudeClearableDraft, claudeHeldIsGrey, claudeInputBoxContent, claudeInputBoxText, claudeInputDraft, claudeInputEmpty, claudeRestoredDraft, claudeRewindOpen, historyEndShowsLive, isClaudeHeld, parseClaudeSuggestion, shownInputBox, viewportShowsLive } from "./claude-input.ts";
export { hermesInputDraft } from "./hermes-input.ts";
export { OpenCodePromptState } from "./opencode-prompt.ts";
export { openOmoAsks, pendingOmoAsk } from "./omo-questions.ts";
export { codexQueuedPrompt } from "./codex-queue.ts";
export type { QueueFront } from "./codex-queue.ts";

/** What the chat last sent to each pane, while it carried invisible characters (noteSubmitted). */
const heldCandidates = new Map<string, { text: string; at: number }>();
/** Long enough to read the card and answer it; a message kept past this is the user's own business */
const HELD_WINDOW_MS = 10 * 60_000;
type PaneCommandSend = CommandSend & {
  store: string | null;
  /** Session discovery is visibility metadata, not command completion evidence. */
  visibility?: {
    readonly terminalId: string;
    discovering: boolean;
    identity: string;
    /** The agent process the send went to (bindCommandProcess); null when it could not be told, none when not bound. */
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
    /** Set while the binding's read is out: a poll waits for it, within BINDING_WAIT_MS. */
    binding?: Promise<void>;
    /** Polls in a row that did not find the bound process in the foreground, where its start time cannot say. */
    misses?: number;
    replaced?: true;
  };
  /** Visibility only: never changes the send identity used to correlate evidence. */
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

/** The OmO process holding a session among `info`'s, for an OmO send only; read without holding the event loop. */
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

/** How long a poll waits for a send's process binding before it judges that send without one, this time. */
const BINDING_WAIT_MS = 250;

/**
 * How long after a send herdr may still report the session of the process before a restart: a restarted Claude Code
 * keeps the old id until its first turn, seen live for 20 s (F2 r3) and for at least 45 s (todo 42's probe). A send
 * waiting for its own session (`stale`) adopts the next one only this long; after that it stays with the session it
 * was made in, like any other send, so a resumed session (claude -c, codex resume) that truly kept its id does not
 * carry its rows into a later one for long.
 */
const STALE_SESSION_LAG_MS = 60_000;

/** The same process: one pid, and the same start time wherever both are known. */
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
      // the /proc start-time read waits until delivery has its turn
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

/** Whether the send's bound process still runs in the pane; replaced only on proof, never on one look. */
function checkBoundProcess(visibility: NonNullable<PaneCommandSend["visibility"]>, agent: string, processes: ProcessInfo):
  { pid: number; started: number | null } | null {
  const original = visibility.process!;
  // bound as the OmO holding the session, it is still that one: no holder is read again on a poll
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

/** Capture only existing data before delivery. Discovery and transcript reads belong to the poll. */
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
  // a builtin is matched whole or before a space
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

/**
 * Whether the pane's cached catalog lists `text`'s `/name` as a prompt template. A hint only: what that
 * Pi loaded may differ, so the receipt stays (pi-delivery.ts settles it on the first record after it).
 */
export function piListsTemplate(pane: HerdrPane, text: string): boolean {
  const name = /^\/(\S+)(?:\s|$)/u.exec(piRecordText(text))?.[1];
  const cached = cachedPaneCommands(pane);
  return name !== undefined && cached?.agent === "pi" && cached.commands.some((row) =>
    row.trigger === undefined && row.source !== "builtin" && row.source !== "skill" && row.name === name);
}

/** The send record for `text` against a given catalog: the remembered one above, or one the delivery already waited for. */
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
 * Each successful chat send, as it returns. `prompt`: it is a prompt, which begins a turn; a
 * slash command may run with none, and Claude Code may hold a message with invisible characters.
 * `sentAt`: when the send's Enter was sent, where its sender knows.
 */
export function onChatSubmitted(listener: SubmittedListener): () => void {
  submittedListeners.add(listener);
  return () => { submittedListeners.delete(listener); };
}

/**
 * A message the chat just sent to a pane: one with invisible characters may be held by Claude Code.
 * `sentAt`: taken right before the key (or herdr's prompt call) that submitted it.
 */
export function noteSubmitted(paneId: string, text: string, command?: PaneCommandSend, sentAt?: number): void {
  const previous = chatSent.get(paneId)?.commands ?? [];
  const reservations = chatSent.get(paneId)?.reservations ?? new CommandReservations();
  reservations.close(command?.text ?? text, command?.at ?? Date.now());
  if (command) reservations.add(command, registry.readersFor(command.agent));
  const commands = command ? [...previous, command].slice(-5) : previous;
  chatSent.delete(paneId);
  chatSent.set(paneId, { text, commands, reservations });
  if (chatSent.size > 128) chatSent.delete(chatSent.keys().next().value!);
  if (INVISIBLE_CHAR_RE.test(text)) heldCandidates.set(paneId, { text, at: Date.now() });
  else heldCandidates.delete(paneId);
  const prompt = !INVISIBLE_CHAR_RE.test(text) && !text.trimStart().startsWith("/");
  // the message is sent: what a listener makes of it must not turn the send into a failure
  for (const listener of submittedListeners) {
    try { listener(paneId, prompt, sentAt); } catch (error) { console.error(`chat send on ${paneId}: a listener failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/** The text of the pane's last successful chat send (noteSubmitted), or none. */
export function lastChatSubmitted(paneId: string): string | null {
  return chatSent.get(paneId)?.text ?? null;
}

/** Native observers must name the send they correlated; a timestamp or idle transition alone is not an event. */
export function noteCommandEvidence(paneId: string, id: string, evidence: NonNullable<Parameters<typeof commandOutcome>[2]["evidence"]>): void {
  const commands = chatSent.get(paneId)?.commands ?? [];
  const index = commands.findIndex((sent) => sent.id === id);
  const sent = commands[index];
  if (!sent) return;
  sent.outcome = commandOutcome(paneId, sent, { now: Date.now(), evidence, nextAt: commands[index + 1]?.at });
}

async function commandOutcomes(paneId: string, pane: HerdrPane, prompt: InteractivePrompt | null, screen: string | undefined, readSendId: string | undefined, codexHome?: string, snapshot?: SessionSnapshot): Promise<NonNullable<PanePromptResponse["outcomes"]>> {
  if (!chatSent.get(paneId)?.commands.length) return [];
  chatSent.get(paneId)?.reservations.prune(Date.now());
  screen ??= await liveScreen(paneId).catch(() => "");
  const commands = chatSent.get(paneId)?.commands ?? [];
  const now = Date.now();
  const identity = outcomeIdentity(pane);
  // a send's binding read runs alongside its delivery: it is waited for here, and only so long
  const bindings = commands.flatMap((sent) => sent.visibility?.binding ? [sent.visibility.binding] : []);
  if (bindings.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(bindings), new Promise((resolve) => { timer = setTimeout(resolve, BINDING_WAIT_MS); })]);
    clearTimeout(timer);
  }
  // the process is read only while some send still waits for its session, or is inside its window
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
    } catch { /* no answer this poll */ }
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
    // past herdr's lag, or once Chat itself changed the session after it, the session this send was made in was its own
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
    // A send racing this GET must not inherit a screen read before that send.
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
    // A send in the new session can arrive before its first poll. Its captured identity
    // scopes the initiating receipt even though that later send has closed its evidence window.
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
 * `omoOpen`: every question the session has open (openOmoAsks), for omo's widget of the ones
 * asked without waiting.
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
  const supplied = [answer.option_index !== undefined, answer.option_indices !== undefined, answer.custom_text !== undefined].filter(Boolean).length;
  if (supplied !== 1) throw new InvalidAnswer("Exactly one answer is required.");

  if (answer.custom_text !== undefined) {
    if (typeof answer.custom_text !== "string") throw new InvalidAnswer("Custom text must be a string.");
    // A raw newline/control in rpiv's inline input can submit it and type into the next
    // question, review, or composer. Validate before trimming and before any navigation.
    if ((parsed.responder === "pi-ask-question" || parsed.responder === "pi-questionnaire-question") && /[\u0000-\u001f\u007f-\u009f]/.test(answer.custom_text)) {
      throw new InvalidAnswer("Pi custom answers must be one line without control characters.");
    }
    const text = answer.custom_text.trim();
    if (!text || parsed.customMenuIndex === null || (parsed.multi_select && parsed.responder !== "claude-question")) throw new InvalidAnswer("This prompt does not accept a custom answer.");
    if (parsed.responder === "fallback-gjc-menu") {
      if (/[\r\n]/.test(text)) throw new InvalidAnswer("Use the terminal for a multiline GJC custom answer.");
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new InvalidAnswer("Custom text contains unsupported control characters.");
      // GJC handles bracketed paste atomically without /, @ or # autocomplete, as in core/pending.ts.
      return [...keySteps([...navigationKeys(parsed.customMenuIndex - parsed.selectedIndex), KEY.enter]), { text: `\u001b[200~${text}\u001b[201~` }, ...keySteps([KEY.enter])];
    }
    if (parsed.customSteps) return parsed.customSteps(text);
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
/** panes whose wait is logged at most; past it a new wait goes unlogged rather than relogging one */
const FALLBACK_LOGGED_MAX = 256;

/**
 * The question each pane's queue opened on when that was not the card's (a skipped
 * question leaves the rollout's newest-first guess behind): the next card shows it.
 */
const queueFronts = new Map<string, QueueFront & { rollout: string }>();

/**
 * Which asking of its prompt each pane shows. A prompt's own id is a hash of what it says, so the
 * same question asked twice in a row would be one card: an answer tapped for the first asking (or
 * a typed pick left waiting for Confirm) would go to the second. The id a card carries therefore
 * names the asking too, and a
 * new asking starts on any evidence that the last one ended: a read that showed no prompt or
 * another one, an answer sent from here, the agent back at work. With none of these (answered in
 * a terminal and asked again between two reads, by an agent that reports no work in between)
 * two askings cannot be told apart from the screen.
 */
/** `call`: the omp ask call the asking's card was read under (omp-ask.ts ompCallPrompt), once a read proved one */
interface Asking { content: string | null; n: number; queued: boolean; call?: string }
const askings = new Map<string, Asking>();
/** counted across panes and never reused: a pane forgotten here starts no asking over */
let askingCount = 0;
/** this run of the server: a card read before a restart is not one of this run's askings */
const SERVER_RUN = randomBytes(6).toString("hex");
/**
 * The panes an answer is on its way to. Its keys redraw the menu (a move, a row opened for typing,
 * pi's dialog with its cursor off the first row), so what another read finds meanwhile says
 * nothing about the asking: it neither ends it nor starts one. The answer reads the screen
 * itself before its first key that is not a move, and promptWaitEnded still ends the asking
 * under it.
 */
const answersUnderWay = new Set<string>();
/**
 * How many answers have begun or ended on each pane. A read takes its time: one that began
 * before or under an answer and comes back after it shows a screen of that answer's, not of now,
 * so a read during which this number moved changes nothing either.
 */
const answerTurns = new Map<string, number>();

/**
 * The prompt a read found, under the id of its asking; a read without one ends the pane's asking.
 * `turns`: the pane's answerTurns when the read began.
 */
function asked(paneId: string, prompt: InteractivePrompt | null, turns: number): InteractivePrompt | null {
  let asking = askings.get(paneId);
  if (!answersUnderWay.has(paneId) && (answerTurns.get(paneId) ?? 0) === turns) {
    if (prompt === null) {
      if (asking) asking.content = null;
      return null;
    }
    const call = parsedByPublicPrompt.get(prompt)?.ompCall;
    // the same drawing under another ask call is another asking: omp asked again with the same questions
    if (asking?.content !== prompt.id || call !== undefined && asking.call !== undefined && asking.call !== call) {
      // kept until its pane closes (readPrompt): a live asking is never dropped to make room
      asking = { content: prompt.id, n: askingCount += 1, queued: prompt.queued !== undefined };
      askings.set(paneId, asking);
    }
    if (call !== undefined) asking.call = call;
  }
  if (prompt === null) return null;
  prompt.id = createHash("sha256").update(JSON.stringify([prompt.id, SERVER_RUN, asking?.n ?? 0])).digest("hex").slice(0, 12);
  return prompt;
}

/** The pane's prompt was answered: the same prompt on its screen after this is asked anew. */
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

/** A prompt's id as its text alone makes it, whichever asking it is. */
function contentId(prompt: InteractivePrompt | null): string | undefined {
  return prompt ? parsedByPublicPrompt.get(prompt)?.id : undefined;
}

/** When each pane's OmO/rpiv custom form was last answered from the chat (see readPrompt). */
const formsAnswered = new Map<string, number>();
const FORM_SETTLE_MS = 3_000;

const defaultOpenCodeState = new OpenCodePromptState();

/** Each pane's rollout, resolved for its collapsed queue: a poll every 2s would otherwise redo it. */
const queueRollouts = new Map<string, { path: string | null; at: number }>();
const QUEUE_ROLLOUT_MS = 15_000;

/**
 * The chat's own message back in Claude's box (claudeRestoredDraft), only when the live screen holds
 * it: a pane scrolled into its history can show an older box with the same words. The viewport read
 * the route already made is checked first, so a box without the copy costs no further read; then
 * the live screen's box is read as the send paths read it, with the viewport's colors only where
 * viewportShowsLive verifies they show that screen.
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

async function readPrompt(paneId: string, codexHome?: string, openCodeStateDir?: string, openCodeState = defaultOpenCodeState, signal?: AbortSignal): Promise<{ agent: string; status: string; prompt: InteractivePrompt | null; pane: HerdrPane; panes: HerdrPane[]; snapshot: SessionSnapshot; screen?: string; stale?: boolean; inputUnverified?: true }> {
  const before = openCodeState.checkpoint();
  const snapshot = await openCodeState.snapshot();
  const { panes } = snapshot;
  // a closed pane's wait has ended too
  for (const logged of fallbackLogged) if (!panes.some((candidate) => candidate.pane_id === logged)) fallbackLogged.delete(logged);
  for (const known of askings.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) askings.delete(known);
  for (const known of answerTurns.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) answerTurns.delete(known);
  for (const known of heldCandidates.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) heldCandidates.delete(known);
  for (const known of chatSent.keys()) if (!panes.some((candidate) => candidate.pane_id === known)) chatSent.delete(known);
  openCodeState.reconcile(panes, before);
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const agent = pane.agent ?? "";
  const status = pane.agent_status;
  // counted right before the screen is read, after the snapshot: what matters is whether an
  // answer ran while the screen was being read
  const turns = answerTurns.get(paneId) ?? 0;
  const known = await readKnownPrompt(paneId, pane, agent, codexHome, panes, openCodeStateDir, openCodeState, signal, true);
  if (known.stale) return { agent, status, prompt: null, pane, panes, snapshot, stale: true };
  // A custom form just answered can close before Herdr stops reporting blocked. Its hint may
  // outlive the widget, but that is no input to offer as fallback keys. Known next steps still
  // show immediately; only an unrecognized screen waits for this bounded settling window.
  const settling = Date.now() - (formsAnswered.get(paneId) ?? 0) < FORM_SETTLE_MS;
  // a pi pane gets no generic card (readKnownPrompt says so through suppressFallback)
  if (known.prompt !== null || known.suppressFallback || status !== "blocked" || !agent || settling) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, known.prompt, turns), pane, panes, snapshot, screen: known.screen, inputUnverified: known.inputUnverified };
  }
  // herdr says the agent waits on the user and no reader knows the screen: the fallback card
  const screen = known.screen ?? await liveScreen(paneId);
  // Codex's collapsed question queue reads blocked while its main prompt takes a message; a
  // model list of Claude Code's or Codex's that no reader could read is left to the terminal
  // (registry.waits); Claude's own input box (a `❯` or bash `!` row between the last two rules)
  // ending the screen is no dialog: herdr says blocked a moment before Claude draws its panel,
  // and for a second or two after it closes
  if ((agent === "codex" && codexQuestionsCollapsed(screen)) || registry.waits(agent, screen)
    || (agent === "claude" && claudeInputBoxEndsScreen(screen))) {
    fallbackLogged.delete(paneId);
    return { agent, status, prompt: asked(paneId, null, turns), pane, panes, snapshot, screen };
  }
  const prompt = asked(paneId, parseFallbackPrompt(agent, screen), turns)!;
  if (!fallbackLogged.has(paneId) && fallbackLogged.size < FALLBACK_LOGGED_MAX) {
    fallbackLogged.add(paneId);
    console.warn(`prompt: ${agent} pane ${paneId} is blocked on a screen no reader knows; fallback card (${prompt.options.length} options)`);
  }
  return { agent, status, prompt, pane, panes, snapshot, screen, inputUnverified: known.inputUnverified };
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

/** The look before a key said no key may go: nothing more of the answer or move is sent (409 prompt_changed). */
export class KeyRefused extends Error {}

/** A pi-ask form opened under a key-driven answer: nothing more is sent. */
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

/** What a look gives back, or undefined once the signal aborts (or the look fails): a look past its deadline is no look. */
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

/** The shell (or anything but omp) took the pane's input under a key-driven omp answer: nothing more is sent. */
class OmpNotInFront extends KeyRefused {}

/** pi no longer holds the pane's input under a key-driven pi answer: nothing more is sent. */
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

/** A move between a form's questions ran out of its request's time, or its asking ended: no further key. */
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

/** omp asked again (or its call closed) since the card was read: nothing more is sent. */
class OmpCallChanged extends KeyRefused {}

/** Whether the card's open ask call (ompCallPrompt) is still the pane's one open ask call, looked at within the deadline. */
async function ompCallStillOpen(paneId: string, cwd: string, call: string, deadline: AbortSignal): Promise<boolean> {
  if (!cwd) return false;
  const open = await untilAborted((async () => {
    const path = (await ompTranscriptPath(paneId, cwd)).path;
    return ompOpenCall(ompAskReader.read(path), path);
  })(), deadline);
  return open === call;
}
const ompAskReader = new OmoAskReader(ompAsksAfter);

/** Bind omp tab moves to its open call, and optionally restore the call's Markdown (omp-ask.ts). */
/**
 * Each omp pane's last session lookup that answered, which a lookup that fails for a while stands in for, and the
 * failures in a row since: past OMP_LOOKUP_FAILURES the pane's session reads as unproved.
 */
const ompLookups = new Map<string, { path: string; open: OmoAsks; failures: number }>();
const OMP_LOOKUP_FAILURES = 3;

async function withOmpMarkdown(paneId: string, cwd: string, prompt: InteractivePrompt, markdown: boolean): Promise<{ prompt: InteractivePrompt; unverified?: true; rebind: (prompt: InteractivePrompt) => InteractivePrompt }> {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (parsed?.responder !== "omp-question" && parsed?.responder !== "omp-submit" && !parsed?.nativeSteps) return { prompt, rebind: (card) => card };
  let path = "";
  let open: OmoAsks = [];
  let unverified: true | undefined;
  try {
    if (cwd) {
      path = (await ompTranscriptPath(paneId, cwd)).path;
      open = ompAskReader.read(path);
      ompLookups.delete(paneId);
      ompLookups.set(paneId, { path, open, failures: 0 });
      if (ompLookups.size > 64) ompLookups.delete(ompLookups.keys().next().value!);
    }
  } catch (error) {
    const last = ompLookups.get(paneId);
    // Not written yet, no lookup that ever answered, or one failing for long: ordinary answers remain usable, unbound.
    if (error instanceof ConversationNotStarted || !last || last.failures + 1 >= OMP_LOOKUP_FAILURES) ompLookups.delete(paneId);
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
  // the same binding for another drawing of the screen, with what this lookup found (readKnownPrompt's settle)
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
  /** the card as the chat shows it (omp's own Markdown, withOmpMarkdown); an answer's reads compare only ids and keys, which are the screen's either way */
  markdown = false,
  /**
   * for a key's verifying read: once every other look of this read is done, the screen is read again as it was
   * read before and parsed with what this read found; a card the screen no longer draws so authorizes no key
   */
  settle = false,
): Promise<{ prompt: InteractivePrompt | null; screen?: string; stale?: boolean; inputUnverified?: true; suppressFallback?: true;
  /** the card as the settling read drew it: the same card, its cursor where the screen has it now */ settled?: InteractivePrompt }> {
  // no native card (no session herdr reports, no verified v2 service, no pending form): OpenCode
  // v1's own question prompt is read off the screen below (dialogs/opencode.ts, #1386)
  native: if (agent === "opencode") {
    const sessionID = opencodeSessionId(pane);
    if (!sessionID) break native;
    const state = openCodeState.begin(paneId, sessionID);
    // only the process service.json names, as /api/info proves it; never a service started here
    const config = (await openCodeService(openCodeStateDir, signal, { onWindows: true }))?.config ?? null;
    const revision = state.revision;
    const issued = ++state.issued;
    const forms = config ? await listPendingQuestionForms(config, sessionID, signal) : null;
    if (signal?.aborted || openCodeState.entries.get(paneId) !== state) return { prompt: null, stale: true };
    if (state.revision === revision && issued >= state.applied) {
      state.applied = issued;
      state.available = forms !== null;
      // Failure is not evidence of settlement. Keep the last native card and its identity.
      if (forms !== null) {
        state.listed = forms[0] ?? null;
        if (state.listed === null && state.form !== null) {
          state.draft = undefined;
          state.form = null;
          state.revision++;
        }
      }
    }
    // A late read renders the newer applied form and draft, never a synthetic empty card.
    const form = state.listed;
    if (!form || form.fields.length === 0) break native;

    // Schema changes under a reused form id are a replacement too.
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

  if (!["claude", "omp", "codex", "omo", "pi", "gjc", "hermes", "cmd", "opencode", ""].includes(agent)) return { prompt: null };
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
  if (piTabs || claudeTabs || ompTabs) {
    // Detection text has no styles. Background or neutral-vs-dim/green text identifies
    // the active tab, not answered boxes: verify the viewport before authorizing moves.
    const before = screen;
    const scrollBefore = await paneScrollInfo(paneId).catch(() => null);
    const colors = await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS }).then(read => read.text, () => null);
    const scrollAfter = await paneScrollInfo(paneId).catch(() => null);
    screen = await liveScreen(paneId);
    // Bottom offsets alone cannot prove that the styled read captured the same question.
    const text = (value: string): string => value.replace(ANSI_RE, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .split(/\r?\n/).map(line => line.trimEnd()).join("\n").trimEnd();
    if (colors !== null && viewportShowsLive(scrollBefore, scrollAfter, colors, before, screen)
      && text(colors) === text(screen)) screen = colors;
    // Plain-text labels remain readable, but authorize no input. Claude's and omp's cards answer as
    // before from plain text: they only go without their steps.
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
    return parseInteractivePrompt(agent, drawn, omoAsks[0] ?? null, omoTrusted, omoAsks, held, pane.agent_status === "working");
  };
  let prompt = piNative ? publicPrompt(piNative) : parseDrawn(screen);
  let rebind = (card: InteractivePrompt): InteractivePrompt => card;
  if (prompt && agent === "omp") {
    const read = await withOmpMarkdown(paneId, pane.cwd ?? "", prompt, markdown);
    prompt = read.prompt;
    rebind = read.rebind;
    if (read.unverified) inputUnverified = true;
  }
  // every omp card answers by keys, and so would a fallback card: offered only while omp holds the input
  if (agent === "omp" && (prompt !== null || pane.agent_status === "blocked") && !(await ompOwnsInput(paneId))) {
    return { prompt: null, screen, suppressFallback: true };
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
  if (agent === "pi" && await piAskRefusesKeys(paneId, signal)) return { prompt: null, screen, suppressFallback: true };
  if (!prompt && agent === "gjc") {
    const fallback = parseFallbackPrompt(agent, screen);
    if (parsedByPublicPrompt.get(fallback)?.responder === "fallback-gjc-menu") return { prompt: fallback, screen };
  }
  const count = agent === "codex" && prompt === null ? queuedQuestionCount(screen) : 0;
  let settled: InteractivePrompt | undefined;
  if (settle && prompt) {
    // read as the card was read (its colours, or the screen's text), after every await above: parsed with no await
    // between, so the card checked is the one the screen draws right now
    const styled = screen.includes("\u001b[");
    const drawn = await (styled
      ? paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS }).then(read => read.text)
      : liveScreen(paneId)).catch(() => null);
    const again = drawn === null ? null : parseDrawn(drawn);
    const now = again ? rebind(again) : null;
    const at = (card: InteractivePrompt): number | undefined => card.steps?.findIndex(step => step.current);
    if (!now || now.id !== prompt.id || at(now) !== at(prompt)) inputUnverified = true;
    else settled = now;
  }
  if (count === 0 || !pane.cwd) return { prompt, screen, inputUnverified, ...(settled ? { settled } : {}) };
  let rollout = queueRollouts.get(paneId);
  if (!rollout || Date.now() - rollout.at > QUEUE_ROLLOUT_MS) {
    // a store a Codex process placed is checked against the one the lookup's own read sees (#2774)
    const store = await paneCodexHomePlaced(paneId, codexHome);
    rollout = { path: await codexTranscriptPath(paneId, pane.cwd, store.home, undefined, false, store.placed && !codexHome), at: Date.now() };
    queueRollouts.set(paneId, rollout);
    if (queueRollouts.size > 64) queueRollouts.delete(queueRollouts.keys().next().value!);
  }
  try {
    // a question remembered from another rollout (a new session) means nothing here
    const front = queueFronts.get(paneId);
    if (front && front.rollout !== rollout.path) queueFronts.delete(paneId);
    return {
      prompt: rollout.path ? codexQueuedPrompt(screen, await unansweredCodexQuestions(rollout.path), front?.rollout === rollout.path ? front : null) : null,
      screen,
    };
  } catch {
    return { prompt: null, screen }; // the rollout went away
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
 * if it is the one the card showed (title and options). Another one stays open, so the
 * chat's next read shows the question actually waiting (a skip can leave the rollout's
 * guess behind); a queue that does not open is left alone.
 */
async function openQueuedQuestion(paneId: string, queued: ParsedPrompt, givenUp: () => boolean = () => false, opens: (open: boolean) => void = () => undefined): Promise<InteractivePrompt | null> {
  // the key only once the screen still shows the questions' count, nothing of the user's queued,
  // and while somebody still waits for the answer (asked after the read, which takes its time)
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

/** Closes Codex's queue if a question shows open in it. */
async function closeOpenQuestion(paneId: string): Promise<void> {
  const screen = await liveScreen(paneId);
  if (parsePrompt("codex", screen)?.responder === "codex-async-question") await paneSendKeys(paneId, [KEY.closeQueue]);
}

/** How long an answer waits for the menu to show the cursor on its row, before it is refused. */
const SETTLE_MS = 1_500;

/**
 * After an answer to a form of several questions (omo, Claude's question tabs), to one of Claude's
 * other dialogs (a tool approval, a plan, the folder-trust check) or to a model list (Claude Code,
 * Codex): back once the pane shows its next step (the next question, the review, a model's levels,
 * or nothing when it was submitted or closed), so the card's read right after the answer gets that
 * step and never the one just answered. `still` says whether a read is the step just answered. A
 * screen that does not move within a second leaves it to the card's next poll.
 */
async function formMovedOn(paneId: string, still: (prompt: InteractivePrompt | null) => boolean, codexHome?: string, openCodeStateDir?: string): Promise<void> {
  // a second in all, however long each read takes
  const deadlineAt = Date.now() + 1_000;
  for (let attempt = 0; attempt < 20 && Date.now() < deadlineAt; attempt += 1) {
    await Bun.sleep(50);
    const read = await readPrompt(paneId, codexHome, openCodeStateDir).catch(() => undefined);
    // A failed read says nothing about whether the screen moved on.
    if (read === undefined || read.stale) continue;
    if (!still(read.prompt)) return;
  }
}

/** The step answered, by what it says: the answer ended that asking, so the same step still on screen has a new id. */
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

function promptChanged(): Response {
  return jsonResponse({ error: { code: "prompt_changed", message: "The interactive prompt changed; reopen it and try again." } }, 409);
}

export interface PromptRequestOptions {
  /** runs a pane's answer after the input already queued for it (a composer message in flight) */
  serialize?: <T>(paneId: string, task: () => Promise<T>) => Promise<T>;
  /** Native Codex store, for the rollout behind a collapsed queue; defaults to CODEX_HOME */
  codexHome?: string;
  /** a Claude pane's transcript, for the plan file behind a plan card */
  claudeTranscript?: (paneId: string) => string | null;
  /** the requester can only watch: it gets the screen's card, never the plan file's text or path */
  readOnly?: boolean;
  /** OpenCode state dir where service.json lives; tests use an isolated directory */
  openCodeStateDir?: string;
  /** Each server owns its drafts and clears them when stopped. */
  openCodeState?: OpenCodePromptState;
  /** an answer reached the agent (a 2xx that sent it on, not a saved step or a navigation), for the daily active message's usage */
  onAnswered?: () => void;
  /** how long an answer or a move may take, from its first read to its last key (ms); tests shorten it */
  answerDeadlineMs?: number;
  /** the look right before each key an answer or a move sends (beforeKey); tests stand in for it */
  beforeKey?: (paneId: string, agent: string, deadline: AbortSignal) => Promise<void>;
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

export async function handlePromptRequest(request: Request, url: URL, options: PromptRequestOptions = {}): Promise<Response | null> {
  if (url.pathname !== "/api/pane/prompt" && url.pathname !== "/api/pane/prompt/answer") return null;
  setRequestRoute(url.pathname);
  // the answer being handled, once its body was read: what the log line says even when the handling throws
  let answerLog: { paneId: string; matched: boolean } | null = null;
  try {
    if (url.pathname === "/api/pane/prompt") {
      if (request.method !== "GET") return badRequest("method_not_allowed", "GET is required.");
      const paneId = url.searchParams.get("pane_id")?.trim();
      if (!paneId) return badRequest("missing_pane_id", "pane_id is required.");
      const readSendId = chatSent.get(paneId)?.commands.at(-1)?.id;
      const read = await readPrompt(paneId, options.codexHome, options.openCodeStateDir, options.openCodeState, request.signal);
      if (read.stale) return promptChanged();
      const { agent, status } = read;
      // `plan=0` is how a connection server asks for a watching device through its PC proxy, which
      // reaches this PC with its own credential: it only ever narrows the answer
      const watching = options.readOnly || url.searchParams.get("plan") === "0";
      const prompt = watching ? read.prompt : await withPlanFile(read.prompt, options.claudeTranscript?.(paneId));
      // no menu up: what Claude suggests typing next, for the composer's placeholder, and the chat's
      // own last message where Claude put it back into the box on a cancel. Only a nicety: it is read
      // only while Claude waits for the next prompt (a working agent shows none), and a failed or
      // slow read of it (a herdr without ansi reads, a busy one) leaves the prompt answer as it is,
      // on time.
      const box = prompt === null && agent === "claude" && (status === "idle" || status === "done")
        ? await paneRead({ paneId, source: "visible", format: "ansi", timeoutMs: SUGGESTION_READ_MS })
          .then((read) => read.text, () => null)
        : null;
      const outcomes = await commandOutcomes(paneId, read.pane, read.prompt, read.screen, readSendId, options.codexHome, read.snapshot);
      return jsonResponse({
        prompt,
        suggestion: box === null ? null : parseClaudeSuggestion(box),
        restored: box === null ? null : await restoredOnLiveScreen(paneId, box).catch(() => null),
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

    // read, checked and answered in the pane's turn: a message still in flight goes first, and
    // one sent meanwhile waits until the queue is opened, answered and closed again
    const serialize = options.serialize ?? (<T>(_paneId: string, task: () => Promise<T>) => task());
    const form: { still?: (prompt: InteractivePrompt | null) => boolean } = {};
    const log = { paneId: body.pane_id, matched: false };
    answerLog = log;
    // the answer reached the agent: OpenCode or pi-ask took it, or its keys went to the pane. A saved OpenCode
    // step, a step back or a move between pi-ask questions reaches nothing and is no answer (onAnswered)
    let delivered = false;
    const response = await serialize(body.pane_id, async () => {
      // given up while it waited its turn: nothing is read, opened or sent for it
      if (request.signal.aborted) return promptChanged();
      const deadlineMs = options.answerDeadlineMs ?? 4_000;
      const deadlineAt = Date.now() + deadlineMs;
      const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]);
      const keyGuard = options.beforeKey ?? beforeKey;
      const openCodeState = options.openCodeState ?? defaultOpenCodeState;
      // the first read is held to the same deadline as every key after it: past it, nothing is sent
      const first = readPrompt(body.pane_id, options.codexHome, options.openCodeStateDir, openCodeState, deadline);
      first.catch(() => undefined);
      const firstRead = await Promise.race([first, Bun.sleep(Math.max(0, deadlineAt - Date.now())).then(() => null)]);
      if (!firstRead || Date.now() > deadlineAt) return promptChanged();
      const { prompt, agent, pane, panes, inputUnverified } = firstRead;
      // a plan card's id carries its plan file's revision: the file as it is now must match too
      if (inputUnverified || !prompt || (await withPlanFile(prompt, options.claudeTranscript?.(body.pane_id)))!.id !== body.prompt_id) return promptChanged();
      log.matched = true;

      const parsedPrompt = parsedByPublicPrompt.get(prompt);
      // before each key: the look the key needs (beforeKey), then, for an omp card read under an open ask call, that
      // call is still the pane's one open call: omp asking again since the last read takes none of this card's keys
      const ompCall = agent === "omp" ? parsedPrompt?.ompCall : undefined;
      const guardKey = async (paneId: string, keyAgent: string, signal: AbortSignal): Promise<void> => {
        await keyGuard(paneId, keyAgent, signal);
        // a key-driven card of pi's own goes to pi only while pi holds the pane (piOwnsInput)
        if (parsedPrompt?.responder?.startsWith("pi-") && !(await piOwnsInput(paneId))) throw new PiNotInFront();
        if (ompCall !== undefined && !(await ompCallStillOpen(paneId, pane.cwd ?? "", ompCall, signal))) throw new OmpCallChanged();
      };
      /**
       * The one step every key of a move or an answer goes through: the look before the key (guardKey, raced against
       * `guardUntil` unless null), then a read of the pane that settles (readKnownPrompt's `settle`: its last await is a
       * read of the screen), then `same` on what it shows, then the write, started with no await after that check.
       * `screenOnly`: a card checked on the screen's text alone (a menu read as an interaction, pi's dialogs off their
       * first row), whose read has no card of its own to settle.
       */
      const verifyThenSend = async <T>(look: AbortSignal, guardUntil: number | null, readUntil: number,
        same: (shown: ParsedPrompt | null, screen: string, settled: ParsedPrompt | null) => boolean, write: () => T, screenOnly = false): Promise<T> => {
        const guarding = guardKey(body.pane_id, agent, look);
        guarding.catch(() => undefined);
        const guarded = guardUntil === null ? await guarding.then(() => true)
          : await Promise.race([guarding.then(() => true), Bun.sleep(Math.max(0, guardUntil - Date.now())).then(() => false)]);
        if (!guarded) throw new KeyRefused();
        const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir, openCodeState,
          // the card as the answer's first read drew it (readPrompt: omp's own Markdown), so its question compares alike
          AbortSignal.timeout(Math.max(1, readUntil - Date.now())), true, !screenOnly);
        reading.catch(() => undefined);
        const read = await Promise.race([reading, Bun.sleep(Math.max(0, readUntil - Date.now())).then(() => null)]);
        const shown = read?.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
        const settled = read?.settled ? parsedByPublicPrompt.get(read.settled) ?? null : null;
        if (!read || read.inputUnverified || Date.now() > readUntil || !same(shown, read.screen ?? "", settled)) throw new KeyRefused();
        // pi's select and confirm compare by the dialog drawn, which pi leaves on the screen when it ends, and a
        // dialog moved off its first row has no card to compare: pi must still hold the pane after this read too
        if ((parsedPrompt?.responder === "pi-question" || parsedPrompt?.responder === "pi-confirm") && !(await piOwnsInput(body.pane_id))) throw new KeyRefused();
        return write();
      };
      // Next goes on to another question and never answers this one: not with an answer in the same body, and not
      // where the card has no supported move (OpenCode would take it as an answer). Pi tabs and the
      // owned pi-ask bridge have their own navigation metadata rather than nativeSteps.
      if (body.step_next === true && ((!parsedPrompt?.nativeSteps && !parsedPrompt?.piAskForm && !parsedPrompt?.piAskUser)
        || body.option_index !== undefined || body.option_indices !== undefined || body.custom_text !== undefined)) {
        return badRequest("invalid_answer", "Next goes to another question and answers none.");
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
        const stillBound = async (): Promise<boolean> => {
          if (!current()) return false;
          const before = openCodeState.checkpoint();
          const snapshot = await openCodeState.snapshot(Math.max(1, deadlineAt - Date.now())).catch(() => null);
          if (!snapshot) return false;
          openCodeState.reconcile(snapshot.panes, before);
          const live = snapshot.panes.find((candidate) => candidate.pane_id === body.pane_id);
          return !!live && live.agent === "opencode" && opencodeSessionId(live) === openCodeForm.sessionID && current();
        };
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
          // Navigation carries the current step's unsent edits, including an explicit clear.
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
          const sent = chatSent.get(body.pane_id)?.commands.at(-1);
          // OpenCode itself took the answer to the form the sent command opened
          if (sent?.dialogId === prompt.id) noteCommandEvidence(body.pane_id, sent.id, { kind: "native", at: Date.now() });
          // An upstream acknowledgement is authoritative, even after a poll or status change.
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
       * The keys and reads of a move between a form's questions (pi's tabs, omo, Codex, Hermes), each held to the request's
       * deadline: the look before each key (keyGuard) and herdr's write itself, refused past it. Once a key may have been
       * pressed (its write went out, or its reply never came) the move ends this asking on whatever exit it takes, so an
       * unchanged drawing reads as a new asking; a failure proven to come before the write (cancelled, unreachable) does not.
       */
      const moveKeys = (active: () => boolean) => {
        let pressed = false;
        const left = (): number => Math.max(0, deadlineAt - Date.now());
        return {
          pressed: (): boolean => pressed,
          /** `from`: the stop the key moves from, as the read right before the key (verifyThenSend) must still show it */
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

      // a form whose own keys move between its questions (omo, Codex, Hermes): one key at a time, each move seen
      if (parsedPrompt?.nativeSteps && (body.step_back === true || body.step_next === true || body.step_index !== undefined)) {
        const target = nativeStepTarget(parsedPrompt, body);
        if (typeof target === "string") return badRequest("invalid_answer", target);
        if (!draftKept(parsedPrompt, body.draft)) return badRequest("invalid_answer", "Submit or clear edits before switching questions.");
        // a move is a new asking, begun before its first key: a card read before it is refused, while one a poll
        // reads during the move is of this asking and still answers once the move is done
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
          // a move is no answer: the question it ended on is what the pane asks now, under the move's asking
          if (askings.get(body.pane_id) === asking) asking.content = moved.id;
          return jsonResponse({ ok: true });
        } catch (error) {
          if (error instanceof KeyRefused) return promptChanged();
          throw error;
        } finally {
          answersUnderWay.delete(body.pane_id);
          // ended as well as begun: a read that began during the move and comes back after it shows a screen of the
          // move, and changes nothing about the asking
          answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
          if (!done && keys.pressed()) askingEnded(body.pane_id);
        }
      }

      if (parsedPrompt?.responder === "pi-ask-user" && parsedPrompt.piAskUser) {
        const { response, answered } = await answerPiAskUser(body.pane_id, parsedPrompt, body, deadline);
        if (response.ok) askingEnded(body.pane_id);
        if (answered) {
          delivered = true;
          const sent = chatSent.get(body.pane_id)?.commands.at(-1);
          // pi-ask itself took the answer to the form the sent command opened
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
        // a move is a new asking, begun before its first key: a card read before it (another device's,
        // or this tab's before a move away and back) is refused, while one a poll reads during the move
        // is of this asking and still answers once the move is done (#2503 review)
        const prior = askings.get(body.pane_id);
        if (!prior || prior.content === null) return promptChanged();
        const asking: Asking = { content: prior.content, n: askingCount += 1, queued: prior.queued };
        askings.set(body.pane_id, asking);
        const active = (): boolean => !deadline.aborted && askings.get(body.pane_id) === asking && asking.content !== null;
        answersUnderWay.add(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        // pi's own tabs: the same guarded, deadline-bound keys and reads (the look before each key is pi-ask's)
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
          // a move is no answer: the tab it ended on is what the pane asks now, under the move's asking
          if (askings.get(body.pane_id) === asking) asking.content = moved.id;
          return jsonResponse({ ok: true });
        } catch (error) {
          if (error instanceof KeyRefused) return promptChanged();
          throw error;
        } finally {
          answersUnderWay.delete(body.pane_id);
          // ended as well as begun: a read that began during the move and comes back after it shows a
          // screen of the move, and changes nothing about the asking (#2503 review)
          answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
          if (!done && keys.pressed()) askingEnded(body.pane_id);
        }
      }

      // checked against the card before anything is sent: an invalid answer never opens the queue
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
      /** what the card said at the answer's last look: a list drawn as another window by then is another text */
      let lastSeen: string | undefined;
      const opensQueue = parsedByPublicPrompt.get(prompt)?.responder === "codex-queued-question";
      const opensOmo = parsedByPublicPrompt.get(prompt)?.responder === "omo-pending";
      let answered = false;
      let committed = false;
      // whether this request's alt+↑ may have left the queue open
      let queueOpened = false;
      answersUnderWay.add(body.pane_id);
      answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
      try {
        if (request.signal.aborted) return promptChanged();
        if (opensQueue) {
          // the card came from the rollout: answer it in the open queue, once it shows this question
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
        // the keys for the question as it shows in the open queue
        if (target !== prompt) steps = answerKeys(target, body);
        const parsed = parsedByPublicPrompt.get(target)!;
        const responder = parsed.responder;
        const reader = registry.readerFor(responder);
        const interaction = reader?.interaction?.(parsed);
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
        /** the menu as the last look before a key showed it */
        let seen: ParsedPrompt | null = null;
        const looked = (shown: ParsedPrompt | null): void => { seen = shown; lastSeen = shown?.id; };
        /** Whether the screen is the card's own menu, with the cursor on the row the moves were for. */
        const aimed = (shown: ParsedPrompt | null, screen: string): boolean => {
          if (interaction) return shown?.responder === responder && interaction.matches(screen);
          // a dialog of pi's has a card only with its cursor on the first row (parsePiDialog),
          // which the answer's own moves have just left: read off the screen itself
          if ((responder === "pi-question" || responder === "pi-confirm") && cursor !== 0) {
            const dialog = parsePiDialog(screen, true);
            return dialog?.id === parsed.id && dialog.selectedIndex === cursor && promptTailIsActive(dialog, screen);
          }
          return shown?.id === parsed.id && shown.selectedIndex === cursor && ticked(shown)
            && (responder !== "pi-questionnaire-question" || shown.piQuestionnaireInput === undefined);
        };
        /**
         * Waits for the screen to show the card's own menu with the cursor where the moves sent
         * so far leave it. False: the asking ended, nobody waits for the answer, or the menu did
         * not show so within SETTLE_MS.
         */
        let matchedScreen: string | null = null;
        const onRow = async (): Promise<boolean> => {
          const deadline = Date.now() + SETTLE_MS;
          for (;;) {
            // nobody waits for this answer any more: nothing that cannot be undone is started
            if (!asks() || request.signal.aborted) return false;
            const left = deadline - Date.now();
            if (left <= 0) return false;
            // a read that outlasts the wait is no read
            const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir);
            reading.catch(() => undefined);
            const read = await Promise.race([reading, Bun.sleep(left).then(() => null)]);
            if (!read || Date.now() > deadline) return false;
            const shown = read.prompt ? parsedByPublicPrompt.get(read.prompt) ?? null : null;
            if (!read.inputUnverified && asks() && aimed(shown, read.screen ?? "")) { looked(shown); matchedScreen = read.screen ?? ""; return true; }
            await Bun.sleep(50);
          }
        };
        /**
         * Whether a read still shows the question this answer is for (its id carries its call and, for questions drawn alike, its tab).
         * `onCursor`: a key that acts on the row under the cursor (Enter, Space), which must still be the row the moves left it
         * on, in the read and in its settling read (`settled`, the screen as it is right before the key).
         */
        const sameQuestion = (shown: ParsedPrompt | null, screen: string, onCursor: boolean, settled: ParsedPrompt | null): boolean => {
          if (interaction) return shown?.responder === responder && interaction.matches(screen);
          if (responder === "pi-question" || responder === "pi-confirm") {
            const dialog = parsePiDialog(screen, true);
            return dialog?.id === parsed.id && (!onCursor || dialog.selectedIndex === cursor);
          }
          // a fallback card is the screen's own (readPrompt draws it when no reader knows the screen): the same card by
          // what it asks and offers, whatever else ticked on the screen since (a spinner, a timer, a token count)
          if (responder.startsWith("fallback")) {
            const card = parsedByPublicPrompt.get(parseFallbackPrompt(agent, screen));
            return card?.id === parsed.id && (!onCursor || card.selectedIndex === cursor);
          }
          return shown?.id === parsed.id && shown.question === parsed.question && shown.ompCall === parsed.ompCall
            && shown.nativeSteps?.index === parsed.nativeSteps?.index
            && (!onCursor || (shown.selectedIndex === cursor && ticked(shown) && (settled === null || (settled.selectedIndex === cursor && ticked(settled)))));
        };
        // Hermes's multi-select: every key, the ticks after the first and the Enter that locks them, is on the same
        // question, so each is checked against it as the first was, with the rows ticked as this answer's own Spaces left them
        const togglesInPlace = responder === "hermes-question" && body.option_indices !== undefined;
        const ticks = new Set(parsed.checkedOptionIndices);
        function ticked(shown: ParsedPrompt): boolean {
          return !togglesInPlace || (shown.checkedOptionIndices.length === ticks.size && shown.checkedOptionIndices.every((index) => ticks.has(index)));
        }
        const sendStep = async (step: AnswerStep, move: boolean, more: boolean): Promise<void> => {
          const write = async (): Promise<void> => {
            const first = !move && !committed;
            if (!move) committed = true;
            try {
              if (step.keys) await paneSendKeys(body.pane_id, step.keys);
              else if (step.text !== undefined) await paneSendText(body.pane_id, step.text);
            } catch (error) {
              // herdr was never reached, or the write was cancelled, so nothing was pressed: the card is still to be answered
              if (first && error instanceof HerdrError && (error.code === "connect_failed" || error.code === "cancelled")) committed = false;
              throw error;
            }
          };
          // The look and the read are held to the window of a read (SETTLE_MS): the answer as a whole may run past the
          // request's deadline (each key waits for its row), and a cancelled request still finishes the keys it began
          // with, as before. pi's look is as it was (pi-ask's own check, awaited with the request's deadline).
          const look = agent === "pi" ? deadline : AbortSignal.timeout(SETTLE_MS);
          const guardUntil = agent === "pi" ? null : Date.now() + SETTLE_MS;
          if (!committed || togglesInPlace) {
            // every key up to the answer's first one that cannot be undone, that one included: the question as asked
            const onCursor = !move && (step.keys?.every((key) => key === KEY.enter || key === KEY.space) ?? false);
            const { written } = await verifyThenSend(look, guardUntil, Date.now() + SETTLE_MS,
              (shown, screen, settled) => sameQuestion(shown, screen, onCursor, settled), () => ({ written: write() }),
              interaction !== undefined || responder === "pi-question" || responder === "pi-confirm" || responder.startsWith("fallback"));
            await written;
          } else {
            // after it the screen has left the question (an editor, the next question): the path's own checks above stand
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
        const customEditorReady = async (draft: string): Promise<boolean> => {
          const deadline = Date.now() + SETTLE_MS;
          if (responder === "pi-questionnaire-question") {
            const read = await readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir);
            const shown = read.prompt ? parsedByPublicPrompt.get(read.prompt) : null;
            return !read.inputUnverified && asks() && !request.signal.aborted && Date.now() < deadline
              && shown?.id === parsed.id && piQuestionnaireInputMatches(shown, draft)
              && shown.selectedIndex === parsed.customMenuIndex;
          }
          if (responder === "pi-ask-question") {
            // Clear, text and submit each await an RPC: the editor may disappear between them.
            const reading = readKnownPrompt(body.pane_id, pane, agent, options.codexHome, panes, options.openCodeStateDir);
            const read = await Promise.race([reading, Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
            const shown = read?.prompt ? parsedByPublicPrompt.get(read.prompt) : null;
            return !!read && !read.inputUnverified && asks() && !request.signal.aborted && Date.now() < deadline
              && shown?.id === parsed.id && shown.piAskTyping === true && shown.selectedIndex === parsed.customMenuIndex;
          }
          while (asks() && !request.signal.aborted && Date.now() < deadline) {
            const read = await Promise.race([
              paneRead({ paneId: body.pane_id, source: "detection" }),
              Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
            ]);
            if (!read || !asks() || request.signal.aborted || Date.now() >= deadline) return false;
            if (gjcCustomEditorMatches(read.text, parsed, draft)) return true;
            // Retry only the known pre-transition drawing. A dismissed or different question
            // permanently ends this delivery, even if an identical-looking one appears later.
            if (customTyped) {
              if (!gjcCustomEditorMatches(read.text, parsed, "")) return false;
            } else {
              const before = parsedByPublicPrompt.get(parseFallbackPrompt("gjc", read.text));
              if (before?.id !== parsed.id || before.selectedIndex !== parsed.customMenuIndex) return false;
            }
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
          // whether a move of this answer has gone out
          let walked = false;
          for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index]!;
            const move = step.keys?.every((key) => key === KEY.up || key === KEY.down || (sideways && (key === KEY.left || key === KEY.right))) ?? false;
            // the asking ended under the answer: no further key, whatever the screen shows
            if (!asks()) return promptChanged();
            if ((responder === "fallback-gjc-menu" || responder === "pi-ask-question" || responder === "pi-questionnaire-question") && body.custom_text !== undefined && committed) {
              if (!(await customEditorReady(customTyped ? body.custom_text.trim() : ""))) return promptChanged();
              if (step.text !== undefined) customTyped = true;
            }
            // GJC's selector can close under the answer: its composer must not take the moves.
            if (move && walked && (list || reader?.reread === "each-move" || responder === "fallback-gjc-menu") && !(await onRow())) return promptChanged();
            if (!move && (!committed || togglesInPlace)) {
              // The first irreversible step goes only once the menu shows the expected cursor.
              // Later keys follow as before: the menu itself changes under them. Hermes's ticks and
              // Enter after the first tick wait for the cursor and the ticks the last keys left.
              if ((moved || (togglesInPlace && committed)) && !(await onRow())) return promptChanged();
              if (request.signal.aborted) return promptChanged();
            }
            // herdr may press the key and lose its reply; a possibly pressed key ends the asking.
            const key: AnswerStep | null = step.pick ? (seen as ParsedPrompt | null)?.rowKey ?? null : step;
            if (key === null) return promptChanged();
            await sendStep(key, move, index < steps.length - 1);
            if (move) {
              moved = true;
              walked = true;
              for (const key of step.keys!) cursor = key === KEY.down || key === KEY.right ? cursor + 1 : Math.max(0, cursor - 1);
            } else if (togglesInPlace && step.keys?.length === 1 && step.keys[0] === KEY.space) {
              if (!ticks.delete(cursor)) ticks.add(cursor);
            }
          }
        }
        answered = true;
        delivered = true;
        const sent = chatSent.get(body.pane_id)?.commands.at(-1);
        // An incidental question only unblocks the command; only its named dialog can complete it.
        // The card's Esc row (a cancel or refusal: omp's handoff Cancel, Codex's No) is not a result.
        if (committed && sent?.dialogId === prompt.id && sent.form?.dialog === parsed.responder
          && body.option_index !== parsed.rejectWithEscapeIndex) noteCommandEvidence(body.pane_id, sent.id, { kind: "dialog", at: Date.now() });
      } catch (error) {
        if (error instanceof InvalidAnswer) return badRequest("invalid_answer", error.message);
        if (error instanceof KeyRefused) return promptChanged();
        throw error;
      } finally {
        answersUnderWay.delete(body.pane_id);
        answerTurns.set(body.pane_id, (answerTurns.get(body.pane_id) ?? 0) + 1);
        // the queue this request opened never stays open, whatever failed on the way
        if (queueOpened && !answered) await closeOpenQuestion(body.pane_id).catch(() => undefined);
        // answered, or as good as: the same prompt on the screen after this is asked anew
        if (committed) askingEnded(body.pane_id);
        // sent or dropped from its card: the same words in the box after this are a new message
        if (committed && parsedByPublicPrompt.get(target)?.responder === "claude-held") heldCandidates.delete(body.pane_id);
      }
      // answered from the chat, the queue closes again: the next question waits collapsed, and
      // the main prompt (where a message typed in the chat goes) has the input back
      if (parsedByPublicPrompt.get(target)?.responder === "codex-async-question") {
        queueFronts.delete(body.pane_id);
        // by what it says, as closeQueue reads it off the screen
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
      return jsonResponse({ ok: true });
    });
    // the wait for the form's next step only reads the pane: after the pane's turn, so a message
    // queued for it meanwhile is not held up behind the polls
    if (form.still !== undefined) await formMovedOn(body.pane_id, form.still, options.codexHome, options.openCodeStateDir);
    if (response.ok && delivered) options.onAnswered?.();
    await logAnswer(log, response);
    return response;
  } catch (error) {
    // a read or a send that threw (a herdr timeout, 502) is an outcome too
    const response = errorResponse(error);
    if (answerLog !== null) await logAnswer(answerLog, response);
    return response;
  }
}

/** One line per answer that got as far as the pane: the pane, whether the card's prompt still stood, and the
 * refusal's own code (prompt_changed, invalid_answer, agent_blocked, a herdr error...). Never the answer. The pane
 * id is the client's until the snapshot has checked it, so it is logged as a JSON string: one field, whatever it holds. */
async function logAnswer(log: { paneId: string; matched: boolean }, response: Response): Promise<void> {
  const outcome = response.ok ? "ok" : ((await response.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? `status_${response.status}`;
  // quoted as JSON: a space or a newline in the client's id cannot pass for a field of the line
  const pane = JSON.stringify(log.paneId.slice(0, 80));
  console.log(`[prompt/answer] pane=${pane} prompt_matched=${log.matched} outcome=${outcome}`);
}
