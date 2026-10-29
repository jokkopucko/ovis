/**
 * The screen work behind a chat send, owning no server state: clearing a Claude or Hermes input
 * box before a message, the message's own shape, the refusal a draft earns, and the immediate send
 * itself (createSubmitText), handed the state it reads. Pending delivery and the immediate send
 * share them.
 */
import type { HerdrPane } from "../../shared/protocol.ts";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { agentPrompt, HerdrError, paneGet, paneProcessInfo, paneRead, paneScrollInfo, paneSendKeys, paneSendText, type ProcessInfo } from "../herdr/client.ts";
import { mirrorInput } from "../mirror-input.ts";
import { paneAgentOf, resolveAgent, typingRoots } from "../pane-context.ts";
import { paneProcessRoots } from "../conversation.ts";
import type { CommandSend } from "../outcome.ts";
import { processStartedAt } from "../process-start.ts";
import { isOmpProcess, ompLoadsIntegration } from "../omp.ts";
import { processEnviron } from "../omo.ts";
import { bindCommandProcess, CLAUDE_CLEAR_INPUT_KEYS, claudeClearableDraft, claudeInputBoxContent, claudeInputDraft, claudeInputEmpty, claudeRestoredDraft, claudeRewindOpen, codexQuestionsCollapsed, heldCandidate, lastChatSubmitted, hermesInputDraft, noteSubmitted, parseInteractivePrompt, prepareCommandSend, viewportShowsLive } from "../prompt.ts";
import { registry } from "../dialogs/registry.ts";
import { CLAUDE_REWIND_OPEN_MESSAGE } from "../dialogs/claude.ts";
import { type PendingIdentity, PendingInputError } from "../pending-input.ts";
import { startOpenCodeWatch, openCodeSkillsToType, skillsNotAttached } from "../opencode-native.ts";
import { herdrSkillAttachIo, type SkillAttachIo, typeWithSkills } from "../opencode-skill-attach.ts";
import { userHome } from "../user-home.ts";

const CLAUDE_INPUT_DRAFT_MESSAGE = "Claude Code's input box is not empty (a draft, bash mode, or a box that could not be read); send or clear it in the terminal, then send this message";

const HERMES_INPUT_DRAFT_MESSAGE = "Hermes' input in the terminal is not empty (a draft, or an input that could not be read); send or clear it there, then send this message";

/**
 * input_draft, naming the one-row draft the chat may offer to clear (claudeClearableDraft), or none.
 * `box`: the input box as read, whole (claudeInputBoxContent; the client is shown it cut), which a refusal naming no draft shows so the
 * user may send anyway; null where the refusal offers nothing (after a clear began).
 */
export class InputDraftError extends HerdrError {
  readonly draft: string | null;
  constructor(draft: string | null, readonly identity?: PendingIdentity, readonly box: string | null = null, message = CLAUDE_INPUT_DRAFT_MESSAGE) {
    super("input_draft", message);
    this.draft = draft;
  }
}

/** between the two Esc presses that empty Claude Code's restored copy of the chat's message */
const RESTORED_CLEAR_GAP_MS = 200;

/** after them, before the box is read again */
const RESTORED_CLEAR_SETTLE_MS = 300;

/** what a send must still have of its deadline before the copy is cleared: the clear, the box read again, then the send */
const RESTORED_CLEAR_RESERVE_MS = 2_000;

/**
 * A message whose last word is an `@file` mention leaves the agent's file suggestions open over
 * it, and the Enter after the paste takes the suggestion instead of sending: the message stays in
 * the input box (Claude Code 2.1.295, #404). A space after the mention closes them first; a
 * payload already in bracketed-paste markers gets it inside them.
 */
export const closeMention = (text: string): string => {
  const open = text.startsWith("\u001b[200~") ? "\u001b[200~" : "";
  const close = open && text.endsWith("\u001b[201~") ? "\u001b[201~" : "";
  const body = text.slice(open.length, text.length - close.length);
  return /(?:^|\s)@\S+$/.test(body) ? `${open}${body} ${close}` : text;
};

/**
 * The longest line the terminal's input line types raw; a longer one goes to the pane's agent as its prompt.
 * Typed raw, a line reaches the program in pty-sized reads, and Claude Code took each full one for a paste of
 * its own and dropped it before the Enter came: only the tail was sent (#1174). Lines of about 400 characters
 * still arrived whole; 200 (at most 600 bytes) stays well under the smallest read seen, 1,022 bytes.
 */
const TYPED_LINE_MAX = 200;

/** herdr's refusals of an agent.prompt that typed nothing: the input line types the line instead, as the keyboard would */
const PROMPT_REFUSED = new Set(["agent_not_found", "agent_not_ready", "agent_blocked"]);

export const modelSwitchText = (agent: string | null, text: string): string =>
  agent === "omp" && text.trim() === "/model" ? "/switch" : text;

/**
 * Claude Code reads `\` + Enter as a new line, so the Enter after a message whose last character is a
 * backslash adds a line instead of sending: the message stays in the input box (Claude Code 2.1.312,
 * #2277). A space after it lets the Enter send, and Claude Code records the message without the space.
 * A framed payload gets the space inside its closing paste marker.
 * A chat or queued message gets it; the terminal's input line types `\` + Enter as the keyboard does.
 */
export const closeBackslash = (agent: string | null, text: string): string =>
  agent === "claude" ? text.replace(/\\(\u001b\[201~)?$/, "\\ $1") : text;

/** How long after its process starts an omp that has not reported is waited for: from cold it takes up to about 20 s. */
const OMP_STARTUP_MS = 30_000;

/** Between the looks at an omp still starting (untilOmpReported). */
const OMP_REPORT_POLL_MS = 250;

/**
 * omp (18.12.3) draws its input box before it takes an Enter: it connects its submit handler only once
 * its slash commands are loaded, so a message agent.prompt sends meanwhile stays typed in the box and
 * never runs. herdr's omp integration reports the session from omp's `session_start`, which omp emits
 * only after connecting that handler, so while an omp that started moments ago has not reported, the
 * send waits for the report (at most OMP_STARTUP_MS after the process started) and then sends once:
 * nothing is pressed after a send. An omp without the integration (nothing would report it), one that has
 * run longer, or one whose start is unknown is sent to at once, as before.
 */
async function untilOmpReported(paneId: string, pane: HerdrPane, inTime: () => void, pollMs: number, startupMs: number): Promise<HerdrPane> {
  if (pane.agent_session?.source === "herdr:omp") return pane;
  const omp = await ompProcess(paneId);
  inTime();
  const pid = omp?.pid ?? null;
  const started = omp?.integrated ? processStartedAt(omp.pid) : null;
  if (started === null || Date.now() >= started + startupMs) return pane;
  let reported = false;
  while (Date.now() < started + startupMs) {
    await Bun.sleep(pollMs);
    inTime();
    pane = await paneGet(paneId);
    // an omp that quit while it started leaves its shell: the message was for omp, so it is not typed there
    if (resolveAgent(pane).agent !== "omp") throw new HerdrError("pending_target_changed", "The omp this message waited for stopped while it started; nothing was sent");
    if (pane.agent_session?.source === "herdr:omp") { reported = true; break; }
  }
  // reported or out of time, a pane restarted into another omp meanwhile is not the one the message waited for
  // (a lookup that finds no omp proves nothing: the look above already found the pane's agent still omp)
  const now = (await ompProcess(paneId))?.pid ?? null;
  if (now !== null && now !== pid) throw new HerdrError("pending_target_changed", "The omp this message waited for was replaced while it started; nothing was sent");
  if (!reported) console.warn(`[omp] ${paneId}: herdr's omp integration reported no session within ${startupMs / 1000} s of omp starting; sending anyway`);
  return pane;
}

/** The pane's omp process, and whether it loads herdr's omp integration (ompLoadsIntegration); null with none. */
async function ompProcess(paneId: string): Promise<{ pid: number; integrated: boolean } | null> {
  const info = await paneProcessInfo(paneId).catch(() => undefined);
  for (const candidate of info?.foreground_processes ?? []) {
    const argv = Array.isArray(candidate.argv) ? candidate.argv.map(String) : [];
    if (typeof candidate.pid !== "number" || !isOmpProcess(argv)) continue;
    const environ = processEnviron(candidate.pid);
    const home = environ?.find((word) => word.startsWith("HOME="))?.slice(5) || userHome();
    return { pid: candidate.pid, integrated: ompLoadsIntegration(argv, environ, home, candidate.cwd ?? null) };
  }
  return null;
}

/** Is this pane's agent Codex, blocked only by questions waiting collapsed in its queue (codexQuestionsCollapsed)? */
export async function blockedOnlyByCodexQueue(paneId: string): Promise<boolean> {
  const pane = await paneGet(paneId).catch((error: unknown) => {
    if (error instanceof HerdrError && error.code === "pane_not_found") return undefined;
    throw error;
  });
  if (!(await paneIs(pane, "codex"))) return false;
  // A collapsed queue in scrollback must not bypass an approval on the live screen.
  return codexQuestionsCollapsed((await paneRead({ paneId, source: "detection", format: "text" })).text);
}

/** Is this pane's agent `kind`? The omo probe is spent only where the label already says so. */
async function paneIs(pane: HerdrPane | undefined, kind: string): Promise<boolean> {
  return await paneRootsAs(pane, kind) !== null;
}

/** The pane's process roots when its agent is `kind` (paneIs), for a caller that uses herdr's answer again. */
async function paneRootsAs(pane: HerdrPane | undefined, kind: string): Promise<Awaited<ReturnType<typeof paneProcessRoots>> | null> {
  if (!pane || resolveAgent(pane).agent !== kind) return null;
  const roots = await paneProcessRoots(pane.pane_id, kind);
  return resolveAgent(pane, typingRoots(roots)).agent === kind ? roots : null;
}

export const pendingIdentity = (pane: HerdrPane): PendingIdentity => ({
  agent: resolveAgent(pane).agent, terminalId: pane.terminal_id,
  session: pane.agent_session ? `${pane.agent_session.kind}:${pane.agent_session.source}:${pane.agent_session.value}` : null,
});

export const pendingText = (text: string): string => {
  const normalized = text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim() || normalized.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new HerdrError("invalid_submit_text", "A pending chat message must be nonempty text, at most 20000 characters, without terminal control characters");
  }
  return normalized;
};

/** The composer's message cap (src/lib/compose.ts MAX_COMPOSER_CHARS) and the terminal input line's (src/lib/terminalDraft.ts TERMINAL_LINE_LIMIT). */
const MAX_CHAT_SUBMIT_CHARS = 20_000;
const MAX_TYPED_SUBMIT_CHARS = 32_768;

/**
 * An immediate submit as the composer shapes it (src/lib/compose.ts composerMessage and composerPayload), or
 * invalid_submit_text before anything is typed or cleared. `text` is the message as written: trailing newlines
 * dropped, CRLF and a lone CR read as LF, and no terminal control character but tab and newline, so it holds no
 * paste marker. `payload` must be that text with each LF a CR, bare or inside exactly one bracketed-paste pair:
 * a payload that ends its own paste early, or carries bytes its text does not, would run what follows as
 * commands. `typed`: the terminal's input line, whose cap is the longer one.
 */
export function submitFraming(text: string, payload: string, typed: boolean): { text: string; payload: string } {
  const message = text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
  const limit = typed ? MAX_TYPED_SUBMIT_CHARS : MAX_CHAT_SUBMIT_CHARS;
  const body = message.replace(/\n/g, "\r");
  if (message.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)
    || (payload !== body && payload !== `\u001b[200~${body}\u001b[201~`)) {
    throw new HerdrError("invalid_submit_text", `A message must be at most ${limit} characters, without terminal control characters or paste markers, and sent as the composer shapes it; nothing was typed`);
  }
  return { text: message, payload };
}

export const pendingFault = (error: unknown) => ({
  code: error instanceof HerdrError || error instanceof PendingInputError ? error.code : "submit_failed",
  message: error instanceof Error ? error.message : String(error),
});

/**
 * Hermes' input, refused with input_draft unless hermesInputDraft knows it empty. As claudeBoxReads,
 * the viewport's colors are read only for an input row with text, and count only once
 * viewportShowsLive verifies them; the live read comes last, so text typed meanwhile is in it.
 * Hermes offers nothing to clear from here: the user sends or clears it in the terminal.
 */
export async function freeHermesInput(paneId: string, identity?: PendingIdentity): Promise<string> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (!hermesInputDraft(before, null)) return before;
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (hermesInputDraft(live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null)) {
    throw new InputDraftError(null, identity, null, HERMES_INPUT_DRAFT_MESSAGE);
  }
  return live;
}

/**
 * Claude Code's input box as every chat send reads it first, before anything is typed. herdr reports
 * Claude Code idle with its rewind dialog up, which shows no input box: on a Summarize row the message
 * and its Enter would go to the add-context field and summarize the conversation. While any state of
 * that dialog is on screen the send is refused, the Esc that clears a restored copy included.
 */
export async function claudeBoxReads(paneId: string): Promise<[string, string | null]> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (claudeRewindOpen(before)) throw new HerdrError("rewind_dialog_open", CLAUDE_REWIND_OPEN_MESSAGE);
  if (!claudeInputDraft(before, null)) return [before, null];
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  return [live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null];
}

/**
 * The box check both chat sends share: a Claude Code input box that is not known to be empty is
 * refused, except the chat's own last message, which Claude puts back as typed text when the send
 * right after it is cancelled. That copy, while the agent is not working, two Esc presses empty
 * again — never Ctrl+C, which would arm "press Ctrl-C again to exit" — then the box is read once
 * more before the send. Every other draft, and a box still not empty after them, refuses as before.
 * `authorize` throws once the sender may no longer send: it is asked before each Esc, and again
 * right before herdr is written to. A send with less than RESTORED_CLEAR_RESERVE_MS left before its
 * `deadline` clears nothing: it would erase the copy, then time out without sending.
 */
export async function freeClaudeBox(paneId: string, working: boolean, authorize: () => void, deadline: number): Promise<void> {
  let refused: unknown;
  const allowed = (): boolean => { try { authorize(); return true; } catch (error) { refused = error; return false; } };
  // an Esc the guard stopped fails with the sender's own refusal (read_only, device_revoked), not herdr's `cancelled`
  const refusal = (error: unknown): never => { throw refused ?? error; };
  const [live, colors] = await claudeBoxReads(paneId);
  if (!claudeInputDraft(live, colors)) return;
  if (working || claudeRestoredDraft(live, colors, lastChatSubmitted(paneId)) === null) {
    throw new InputDraftError(claudeClearableDraft(live, colors), undefined, claudeInputBoxContent(live));
  }
  if (deadline - Date.now() < RESTORED_CLEAR_RESERVE_MS) throw new HerdrError("submit_timeout", "Too little time was left to clear Claude Code's input box and send; nothing was typed");
  // the read proved the box holds the copy: a lone Esc on an EMPTY box would open Claude's
  // rewind dialog instead
  authorize();
  await paneSendKeys(paneId, ["esc"], undefined, allowed).catch(refusal);
  // fixed wait: Claude Code takes the second Esc only after a gap
  await Bun.sleep(RESTORED_CLEAR_GAP_MS);
  authorize();
  await paneSendKeys(paneId, ["esc"], undefined, allowed).catch(refusal);
  // fixed wait: the box redraws after the two Esc presses before it reads empty
  await Bun.sleep(RESTORED_CLEAR_SETTLE_MS);
  if (claudeInputDraft(...await claudeBoxReads(paneId))) throw new HerdrError("input_draft", CLAUDE_INPUT_DRAFT_MESSAGE);
}

export function createSubmitText({ options, lastTyped, attachments, terminalAttach, SUBMIT_DEADLINE_MS, TYPED_SETTLE_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS, SUBMIT_DELAY_MS }: {
  options: { submitDeadlineMs?: number; submitDelayMs?: number; ompReportPollMs?: number; ompStartupMs?: number; openCodeStateDir?: string };
  lastTyped: Map<string, number>;
  attachments: ReadonlyMap<string, { cols: number }>;
  terminalAttach: () => Promise<boolean>;
  SUBMIT_DEADLINE_MS: number;
  TYPED_SETTLE_MS: number;
  DRAFT_CLEAR_WAIT_MS: number;
  DRAFT_CLEAR_POLL_MS: number;
  SUBMIT_DELAY_MS: number;
}) {
  /**
   * Types a composer message and submits it, with its own Enter after the text: arriving
   * in the same chunk as the paste, a TUI still busy with it (turning an image path into
   * an attachment, redrawing after the phone keyboard closed) could take it for a newline
   * and leave the message unsent in its input box. Done here rather than in the browser,
   * the gap survives a jittery connection and the Enter still goes when the phone locks.
   *
   * An agent gets it through herdr's agent.prompt (the paste, then Enter 300ms later),
   * which refuses while the agent waits for an answer: the message is not typed into its
   * menu. A pane without an agent in front gets `payload`, shaped for its own paste mode,
   * through send_text, then Enter SUBMIT_DELAY_MS later; both return once the pane has
   * the bytes, so the pane sees the whole gap. So does a Codex "blocked" only by questions
   * waiting collapsed in its queue: its main prompt still takes the message.
   */

  /**
   * `clearDraft`: the draft an input_draft refusal named, which the user asked to clear and send
   * over. It goes only while the box still holds exactly that, and the message only once the box
   * reads empty.
   * `sendAnyway`: the user saw the box a refusal naming no draft showed and chose to send: only into
   * the Claude terminal and session that refusal was for (`confirmation` with no draft), and only while
   * the box still shows what they saw or reads empty. Never typed instead of agent.prompt.
   */
  async function submitText(paneId: string, text: string, payload: string, arrivedAt: number, fromTerminal = false, authorize: () => void = () => {},
    clearDraft?: string, confirmation?: { draft: string | null; identity: PendingIdentity; box?: string | null }, sendAnyway = false, agentOnly = false): Promise<void> {
    // before anything reads the pane, types or clears: closeMention and mirrorInput trust this framing
    ({ text, payload } = submitFraming(text, payload, fromTerminal));
    let clearedDraft = false;
    let sentText = text;
    let command: ReturnType<typeof prepareCommandSend>;
    let beforeScreen: string | undefined;
    // herdr's foreground answer read before this send, which the outcome's process binding uses again
    let seen: ProcessInfo | undefined;
    // the send-time screen's history row, once the read alongside delivery confirms it; `noted`: the send it goes on
    let top: number | undefined;
    let noted: CommandSend | undefined;
    const recorded = <T extends CommandSend | undefined>(sent: T): T => {
      if (sent && top !== undefined) sent.top = top;
      noted = sent;
      return sent;
    };
    const inTime = (reserve = 0): void => {
      authorize();
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS) - reserve) {
        throw new HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed");
      }
    };
    // agent.prompt asks the sender once more right before herdr is written to: it can be revoked, or switch
    // to watching, while the connection opens. Its refusal sends nothing, and nothing is typed instead.
    let refused: unknown;
    const mayType = (): boolean => {
      try { authorize(); return true; } catch (error) { refused = error; return false; }
    };
    /** A write mayType stopped fails with the sender's own refusal (read_only, device_revoked), not herdr's `cancelled`. */
    const refusal = (error: unknown): never => { throw refused ?? error; };
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    // fixed wait: herdr holds a lone ESC typed through the attach pty and says nothing when it lets go
    if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
    lastTyped.delete(paneId);
    inTime();
    // the terminal's input line stands in for the keyboard: it types what the user wrote, an
    // answer into an open menu included, where agent.prompt would refuse
    try {
      if (!fromTerminal) {
        let pane = await paneGet(paneId).catch((error: unknown) => {
          if (error instanceof HerdrError && error.code === "pane_not_found") return undefined;
          throw error;
        });
        inTime();
        const identity = pane ? pendingIdentity(pane) : null;
        const sameClaude = (current: PendingIdentity | null): boolean => current?.agent === "claude"
          && confirmation !== undefined && confirmation.draft === clearDraft
          && current.terminalId === confirmation.identity.terminalId && current.session === confirmation.identity.session;
        if (clearDraft !== undefined && !sameClaude(identity)) {
          throw new HerdrError("pending_target_changed", "The named draft's Claude terminal or session changed; nothing was cleared or sent");
        }
        if (sendAnyway && !(identity?.agent === "claude" && confirmation !== undefined && confirmation.draft === null
          && identity.terminalId === confirmation.identity.terminalId && identity.session === confirmation.identity.session)) {
          throw new HerdrError("pending_target_changed", "The refused message's Claude terminal or session changed, or nothing was refused; nothing was sent");
        }
        if (sendAnyway) {
          // only over the box the user was shown: anything typed there since is refused again, and shown
          const reads = await claudeBoxReads(paneId);
          beforeScreen = reads[0];
          inTime();
          const box = claudeInputBoxContent(reads[0]);
          // a box that cannot be read whole cannot be compared: it is refused, and offers no send anyway
          if (claudeInputDraft(...reads) && (box === null || box !== confirmation!.box)) throw new InputDraftError(claudeClearableDraft(...reads), identity ?? undefined, box);
          // the reads waited on herdr: the pane may hold another Claude by now, checked again right before the write
          const now = pendingIdentity(await paneGet(paneId));
          inTime();
          if (now.agent !== "claude" || now.terminalId !== confirmation!.identity.terminalId || now.session !== confirmation!.identity.session) {
            throw new HerdrError("pending_target_changed", "The refused message's Claude terminal or session changed; nothing was sent");
          }
        }
        const claudeRoots = await paneRootsAs(pane, "claude");
        const claude = claudeRoots !== null;
        seen = claudeRoots?.processes;
        // the process lookup waited on herdr: the device may have lost its access meanwhile
        inTime();
        if (claude && !sendAnyway) {
          if (clearDraft === undefined) {
            try {
              await freeClaudeBox(paneId, pane?.agent_status === "working", authorize, arrivedAt + (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS));
            } catch (error) {
              if (error instanceof InputDraftError) throw new InputDraftError(error.draft, identity ?? undefined, error.box);
              throw error;
            }
          }
          let reads = await claudeBoxReads(paneId);
          inTime();
          // reads the pane's state first, then the screen the checks and the caller use, so a prompt
          // that opens while the state is read is on that screen
          const clearScreenReady = async (): Promise<void> => {
            const current = await paneGet(paneId);
            if (clearDraft !== undefined && !sameClaude(pendingIdentity(current))) {
              throw new HerdrError("pending_target_changed", "The named draft's Claude terminal or session changed; nothing was cleared or sent");
            }
            reads = await claudeBoxReads(paneId);
            if (secretPrompt(reads[0], attachments.get(paneId)?.cols) !== null
              || parseInteractivePrompt("claude", reads[0], null, true, [], heldCandidate(paneId)) !== null
              || registry.waits("claude", reads[0]) || current.agent_status === "blocked") {
              throw new HerdrError("agent_blocked", "The terminal is waiting for an answer; its draft was not cleared");
            }
            if (!["working", "idle", "done"].includes(current.agent_status)) {
              throw new HerdrError("agent_not_ready", "The agent's current input state is not known");
            }
          };
          if (clearDraft !== undefined) await clearScreenReady();
          // Send it names the terminal's draft as the message itself. An empty box can mean it
          // was already sent there; only Clear it and send of different text may continue.
          if (clearDraft !== undefined && text === clearDraft && claudeInputEmpty(...reads)) {
            throw new HerdrError("agent_not_ready", "The named draft is no longer in Claude Code's input box; nothing was cleared or sent");
          }
          if (claudeInputDraft(...reads)) {
            // only the draft the user was shown goes, never what has since replaced it
            const draft = claudeClearableDraft(...reads);
            if (clearDraft === undefined || draft !== clearDraft) throw new InputDraftError(draft, identity ?? undefined, clearDraft === undefined ? claudeInputBoxContent(reads[0]) : null);
            const reserve = DRAFT_CLEAR_WAIT_MS + 500;
            inTime(reserve);
            // A confirmation names the earlier draft, not text typed while it was inspected.
            await clearScreenReady();
            inTime(reserve);
            const currentDraft = claudeClearableDraft(...reads);
            if (currentDraft !== clearDraft) throw new InputDraftError(currentDraft, identity ?? undefined);
            // The final draft comparison and clearing keys are not atomic (herdr has no compare-and-clear),
            // so terminal text another client types moments after the user's explicit "Clear it and send"
            // click can also be cleared.
            // Connecting to herdr also yields: check the budget and authority again at the write.
            const allowed = (): boolean => {
              try { inTime(reserve); clearedDraft = true; return true; } catch { return false; }
            };
            try {
              await paneSendKeys(paneId, CLAUDE_CLEAR_INPUT_KEYS, undefined, allowed);
            } catch (error) {
              if (error instanceof HerdrError && error.code === "cancelled") inTime(reserve);
              throw error;
            }
            clearedDraft = true;
            for (const deadline = Date.now() + DRAFT_CLEAR_WAIT_MS; await clearScreenReady(), claudeInputDraft(...reads);) {
              if (Date.now() >= deadline) throw new InputDraftError(claudeClearableDraft(...reads));
              await Bun.sleep(DRAFT_CLEAR_POLL_MS);
            }
            await clearScreenReady();
            if (!claudeInputEmpty(...reads)) throw new InputDraftError(null);
            inTime();
          }
          if (clearDraft !== undefined && !claudeInputEmpty(...reads)) throw new InputDraftError(null);
          beforeScreen = reads[0];
        }
        // a clear request or send anyway reached a Hermes pane only to be refused above: both are Claude's
        const hermesRoots = await paneRootsAs(pane, "hermes");
        const hermes = hermesRoots !== null;
        seen ??= hermesRoots?.processes;
        inTime();
        if (hermes) {
          beforeScreen = await freeHermesInput(paneId, identity ?? undefined);
          inTime();
        }
        // omp's `/model` opens its Models hub, which assigns roles and saves the default one for
        // later sessions, while omp itself calls the command "Switch model for this session":
        // the chat's `/model` opens omp's session-only picker, the one its card answers
        let agent = pane ? resolveAgent(pane).agent : null;
        if (pane && agent === "omp" && pane.agent_session?.source !== "herdr:omp") {
          const roots = await paneProcessRoots(pane.pane_id, agent);
          seen ??= roots.processes;
          agent = resolveAgent(pane, typingRoots(roots)).agent;
        }
        const switched = modelSwitchText(agent, text);
        const sent = closeBackslash(agent, switched);
        sentText = sent;
        payload = switched === text ? closeBackslash(agent, payload) : sent;
        if (pane && agent === "omp") {
          pane = await untilOmpReported(paneId, pane, inTime, options.ompReportPollMs ?? OMP_REPORT_POLL_MS, options.ompStartupMs ?? OMP_STARTUP_MS);
          // the last look waited on herdr: the device may have lost its access meanwhile
          inTime();
        }
        if (pane) command = prepareCommandSend(pane, text, beforeScreen);
        // where that screen sits in the history (outcome.ts scrolledAnchor): the row read before the screen, kept
        // once a read after it agrees, so nothing scrolled in between. That read only records the send, so it runs
        // alongside delivery and is never awaited; one that answers after the echo scrolled disagrees, and one that
        // fails leaves the text anchor. One that agrees after the send was noted still sets the noted send's row;
        // that send's echo reservation was already made with the text anchor, so the row serves only later sends
        const snapshotTop = pane?.scroll?.max_offset_from_bottom;
        if (command && beforeScreen !== undefined && snapshotTop !== undefined) {
          void paneScrollInfo(paneId).then((scroll) => {
            if (scroll?.max_offset_from_bottom !== snapshotTop) return;
            top = snapshotTop;
            if (noted) noted.top = snapshotTop;
          }, () => {});
        }
        inTime();
        // agent.prompt pastes the whole text, and OpenCode v2 leaves a pasted @skill unattached
        let skills: string[] = [];
        if (pane) ({ sent: command, skills } = await openCodeSkillsToType(pane, command, text, beforeScreen, options.openCodeStateDir));
        inTime();
        if (pane && command && skills.length > 0) {
          const expected = pendingIdentity(pane);
          let current = pane;
          // the lookup awaited the service: the pane, its session and its state are read again before every key
          const revalidate = async (): Promise<void> => {
            current = await paneGet(paneId);
            inTime();
            const now = pendingIdentity(current);
            if (now.agent !== expected.agent || now.terminalId !== expected.terminalId || now.session !== expected.session) {
              throw new HerdrError("pending_target_changed", "The pane's terminal or agent session changed; nothing more was typed");
            }
            // as agent.prompt refuses it; an unknown state is typed into, as its fallback below does
            if (current.agent_status === "blocked") throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
          };
          // followed from before the first key: the send's own message can be announced before Enter returns
          const watch = startOpenCodeWatch(pane, command, options.openCodeStateDir);
          await revalidate();
          let typed = false;
          const allowed = (): boolean => {
            try { inTime(); return true; } catch (error) { refused = error; return false; }
          };
          // typed once herdr let a write through: herdrRpc asks a write's guard once connected, right before it
          const io = herdrSkillAttachIo(paneId);
          const writes: SkillAttachIo = {
            ...io,
            sendText: (piece, guard) => io.sendText(piece, () => guard() && (typed = true)),
            sendKeys: (keys, guard) => io.sendKeys(keys, () => guard() && (typed = true)),
          };
          try {
            const typing = typeWithSkills(text, skills, allowed, writes, revalidate);
            bindCommandProcess(paneId, command, seen, pane);
            const { attached, missed, prompt } = await typing;
            // fixed wait: a TUI busy with the typing takes an Enter in the same chunk for a newline (SUBMIT_DELAY_MS)
            await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
            await revalidate();
            if (!allowed()) throw new HerdrError("cancelled", "The message's sender may no longer type into this pane");
            const sentAt = Date.now();
            await paneSendKeys(paneId, ["Enter"], undefined, allowed);
            const final = recorded(skillsNotAttached(command, missed));
            noteSubmitted(paneId, text, final, sentAt);
            watch?.commit(final, prompt, attached);
            return;
          } catch (error) {
            watch?.cancel();
            if (!typed) throw refused ?? error;
            if (error instanceof HerdrError && error.code === "submit_changed") throw error;
            throw new HerdrError("submit_partial", "Part of the message was typed into OpenCode's input, but sending was not confirmed. Your chat text stayed here. Check the terminal before sending again.");
          }
        }
        const watch = pane ? startOpenCodeWatch(pane, command, options.openCodeStateDir) : null;
        try {
          inTime();
          const sentAt = Date.now();
          const delivery = agentPrompt(paneId, closeMention(sent), undefined, mayType);
          // which agent process got it, read alongside the delivery for the outcome's row, never before it
          bindCommandProcess(paneId, command, seen, pane);
          await delivery;
          noteSubmitted(paneId, sent, recorded(command), sentAt);
          if (command) watch?.commit(command, [{ pasted: closeMention(sent) }], []);
          return;
        } catch (error) {
          watch?.cancel();
          if (refused !== undefined) throw refused;
          if (!(error instanceof HerdrError)) throw error;
          if (clearDraft !== undefined || sendAnyway) throw error;
          // a message for an agent alone (#511) is never typed into what is there once the agent has gone
          if (agentOnly && (error.code === "agent_not_found" || error.code === "agent_not_ready")) throw new HerdrError("agent_not_ready", "No agent is in front of this pane now; nothing was typed");
          const queuedOnly = error.code === "agent_blocked" && await blockedOnlyByCodexQueue(paneId);
          if (error.code !== "agent_not_found" && error.code !== "agent_not_ready" && !queuedOnly) throw error;
        }
      }
      // one long line from the input line: herdr's agent.prompt pastes it in the agent's own paste mode and
      // returns once its Enter followed (TYPED_LINE_MAX). An agent waiting for an answer, or none, is typed into.
      if (fromTerminal && !sentText.includes("\n") && sentText.length > TYPED_LINE_MAX) {
        try {
          inTime();
          const sentAt = Date.now();
          await agentPrompt(paneId, closeMention(sentText), undefined, mayType);
          noteSubmitted(paneId, sentText, recorded(command), sentAt);
          return;
        } catch (error) {
          if (refused !== undefined) throw refused;
          if (!(error instanceof HerdrError) || !PROMPT_REFUSED.has(error.code)) throw error;
        }
      }
      inTime();
      // The terminal input line has no pre-read pane identity. Do not add reads just for tracking.
      // a mirrored pane's browser never learned the program's paste mode, so `payload` came as bare
      // lines: several of them are shaped here as the same block typed into the mirror is. herdr is
      // asked only for such a block, so a one-line message never waits on it.
      const shaped = await mirrorInput(closeMention(payload), async () => await terminalAttach() ? null : await paneAgentOf(paneId));
      inTime();
      await paneSendText(paneId, shaped, undefined, mayType).catch(refusal);
      // fixed wait: a TUI busy with the paste takes an Enter in the same chunk for a newline (SUBMIT_DELAY_MS)
      await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
      authorize();
      const sentAt = Date.now();
      await paneSendKeys(paneId, ["Enter"], undefined, mayType).catch(refusal);
      noteSubmitted(paneId, sentText, recorded(command), sentAt);
    } catch (error) {
      if (clearedDraft) {
        throw new HerdrError("submit_partial", "Claude Code's terminal draft was cleared or may have changed, but sending was not confirmed. Your chat text stayed here. Check the terminal before sending again.");
      }
      throw error;
    }
  }
  return submitText;
}
