import { withoutTrailingBreaks } from "../../shared/launch-rules.ts";
import { stripVTControlCharacters } from "node:util";
import type { HerdrPane } from "../../shared/protocol.ts";
import { displayWidth, secretPrompt } from "../../shared/secret-prompt.ts";
import { AGENT_INPUT_DRAFT_MESSAGE, CLAUDE_FOLDED_DRAFT_MESSAGE, GROK_SEND_UNCONFIRMED_MESSAGE, NO_AGENT_MESSAGE } from "../../shared/submit-outcome.ts";
import { agentPrompt, HerdrError, paneGet, paneProcessInfo, paneRead, paneScrollInfo, paneSendKeys, paneSendText, type ProcessInfo, faultOf, type HerdrFailureView } from "../herdr/client.ts";
import { mirrorInput } from "../mirror-input.ts";
import { paneAgentOf, resolveAgent, typingRoots } from "../pane-context.ts";
import { paneProcessRoots } from "../conversation.ts";
import type { CommandSend } from "../outcome.ts";
import { processStartedAt } from "../process-start.ts";
import { isOmpProcess, ompLoadsIntegration } from "../omp.ts";
import { processEnviron } from "../omo.ts";
import { bindCommandProcess, CLAUDE_CLEAR_INPUT_KEYS, claudeClearableDraft, claudeInputBoxContent, claudeInputDraft, foldedPlaceholder, claudeInputEmpty, claudeRestoredDraft, claudeRewindOpen, claudeSendAnywayBox, codexQuestionsCollapsed, heldCandidate, historyEndShowsLive, lastChatSubmitted, hermesInputDraft, noteSubmitted, parseInteractivePrompt, prepareCommandSend, viewportShowsLive } from "../prompt.ts";
import { agentPickerWaits, registry, SCREEN_READ_AGENTS } from "../dialogs/registry.ts";
import { codexOwnScreenOpen, CODEX_OWN_SCREEN_MESSAGE } from "../dialogs/codex.ts";
import { CLAUDE_REWIND_OPEN_MESSAGE } from "../dialogs/claude.ts";
import { type PendingIdentity, PendingInputError } from "../pending-input.ts";
import { startOpenCodeWatch, openCodeSkillsToType, skillsNotAttached } from "../opencode-native.ts";
import { herdrSkillAttachIo, type SkillAttachIo, typeWithSkills } from "../opencode-skill-attach.ts";
import { userHome } from "../user-home.ts";
import { type GrokBeforeSend, grokEcho, grokQueue, sendGrokQueuedNow } from "./grok-queue.ts";
import { drawsColour, inputRowState, readsTypedDraft, screenFromAnsi, typedDraft } from "../../shared/input-row.ts";

const CLAUDE_INPUT_DRAFT_MESSAGE = "Claude Code's input box is not empty (a draft, bash mode, or a box that could not be read); send or clear it in the terminal, then send this message";

const claudeRefusalMessage = (live: string): string => {
  const content = claudeInputBoxContent(live);
  return content !== null && foldedPlaceholder(content, true) ? CLAUDE_FOLDED_DRAFT_MESSAGE : CLAUDE_INPUT_DRAFT_MESSAGE;
};

const HERMES_INPUT_DRAFT_MESSAGE = "Hermes' input in the terminal is not empty (a draft, or an input that could not be read); send or clear it there, then send this message";


export class InputDraftError extends HerdrError {
  readonly draft: string | null;
  constructor(draft: string | null, readonly identity?: PendingIdentity, readonly box: string | null = null, message = CLAUDE_INPUT_DRAFT_MESSAGE) {
    super("input_draft", message);
    this.draft = draft;
  }
}

class ClaudeBoxMovedError extends InputDraftError {}

const RESTORED_CLEAR_GAP_MS = 200;

const RESTORED_CLEAR_SETTLE_MS = 300;

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

const PROMPT_REFUSED = new Set(["agent_not_found", "agent_not_ready", "agent_blocked"]);

export const modelSwitchText = (agent: string | null, text: string): string =>
  agent === "omp" && text.trim() === "/model" ? "/switch" : text;

/**
 * Claude Code reads `\` + Enter as a new line, so the Enter after a message whose last character is a
 * backslash adds a line instead of sending: the message stays in the input box (Claude Code 2.1.312,
 * #2277). Pi's editor does the same (pi-tui 1.5.2). A space after it lets the Enter send, and both
 * record the message without the space.
 * A framed payload gets the space inside its closing paste marker.
 * A chat or queued message gets it; the terminal's input line types `\` + Enter as the keyboard does.
 */
export const closeBackslash = (agent: string | null, text: string): string =>
  agent === "claude" || agent === "pi" ? text.replace(/\\(\u001b\[201~)?$/, "\\ $1") : text;

/** How long after its process starts an omp that has not reported is waited for: from cold it takes up to about 20 s. */
export const OMP_STARTUP_MS = 30_000;

export const OMP_REPORT_POLL_MS = 250;

/**
 * omp (18.12.3) draws its input box before it takes an Enter: it connects its submit handler only once
 * its slash commands are loaded, so a message agent.prompt sends meanwhile stays typed in the box and
 * never runs. herdr's omp integration reports the session from omp's `session_start`, which omp emits
 * only after connecting that handler, so while an omp that started moments ago has not reported, the
 * send waits for the report (at most OMP_STARTUP_MS after the process started) and then sends once:
 * nothing is pressed after a send.
 */
export async function untilOmpReported(paneId: string, pane: HerdrPane, inTime: () => void, options: { ompReportPollMs?: number; ompStartupMs?: number },
  { strict = false, waiting }: { strict?: boolean; waiting?: () => void } = {}): Promise<HerdrPane> {
  const pollMs = options.ompReportPollMs ?? OMP_REPORT_POLL_MS, startupMs = options.ompStartupMs ?? OMP_STARTUP_MS;
  if (pane.agent_session?.source === "herdr:omp") return pane;
  const starting = await startingOmp(paneId, pane, startupMs, strict);
  inTime();
  if (starting === null) return pane;
  waiting?.();
  let reported = false;
  while (Date.now() < starting.until) {
    await Bun.sleep(pollMs);
    inTime();
    pane = await paneGet(paneId);
    // an omp that quit while it started leaves its shell: the message was for omp, so it is not typed there
    if (resolveAgent(pane).agent !== "omp") throw new HerdrError("pending_target_changed", "The omp this message waited for stopped while it started; nothing was sent");
    if (pane.agent_session?.source === "herdr:omp") { reported = true; break; }
  }
  // reported or out of time, a pane restarted into another omp meanwhile is not the one the message waited for
  // (a lookup that finds no omp proves nothing: the look above already found the pane's agent still omp)
  const now = (await ompProcess(paneId).catch(() => null))?.pid ?? null;
  if (now !== null && now !== starting.pid) throw new HerdrError("pending_target_changed", "The omp this message waited for was replaced while it started; nothing was sent");
  if (!reported) console.warn(`[omp] ${paneId}: herdr's omp integration reported no session within ${startupMs / 1000} s of omp starting; sending anyway`);
  return pane;
}

/**
 * A look at its process that herdr does not answer says nothing either way. The immediate send takes it for
 * no omp starting and sends, as it always did; `strict` (the queue) fails on it: not known is not ready, and
 * a message typed into an omp that does not take input yet is one its row says was sent.
 */
async function startingOmp(paneId: string, pane: HerdrPane, startupMs: number, strict: boolean): Promise<{ pid: number; until: number } | null> {
  if (pane.agent_session?.source === "herdr:omp") return null;
  const omp = await ompProcess(paneId).catch((error: unknown) => { if (strict) throw error; return null; });
  const started = omp?.integrated ? processStartedAt(omp.pid) : null;
  return omp === null || started === null || Date.now() >= started + startupMs ? null : { pid: omp.pid, until: started + startupMs };
}

export async function ompStartingUntil(paneId: string, pane: HerdrPane, options: { ompStartupMs?: number }): Promise<number | null> {
  return (await startingOmp(paneId, pane, options.ompStartupMs ?? OMP_STARTUP_MS, true))?.until ?? null;
}

async function ompProcess(paneId: string): Promise<{ pid: number; integrated: boolean } | null> {
  const info = await paneProcessInfo(paneId);
  for (const candidate of info?.foreground_processes ?? []) {
    const argv = Array.isArray(candidate.argv) ? candidate.argv.map(String) : [];
    if (typeof candidate.pid !== "number" || !isOmpProcess(argv)) continue;
    const environ = processEnviron(candidate.pid);
    const home = environ?.find((word) => word.startsWith("HOME="))?.slice(5) || userHome();
    return { pid: candidate.pid, integrated: ompLoadsIntegration(argv, environ, home, candidate.cwd ?? null) };
  }
  return null;
}

export async function blockedOnlyByCodexQueue(paneId: string): Promise<boolean> {
  const codex = async (): Promise<boolean> => paneIs(await paneGet(paneId).catch((error: unknown) => {
    if (error instanceof HerdrError && error.code === "pane_not_found") return undefined;
    throw error;
  }), "codex");
  if (!(await codex())) return false;
  // A collapsed queue in scrollback must not bypass an approval on the live screen.
  if (!codexQuestionsCollapsed((await paneRead({ paneId, source: "detection", format: "text" })).text)) return false;
  // the screen was Codex's only if Codex still runs once it is read: one that exited meanwhile left a shell to type into
  return await codex();
}

async function paneIs(pane: HerdrPane | undefined, kind: string): Promise<boolean> {
  return await paneRootsAs(pane, kind) !== null;
}

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
  const written = withoutTrailingBreaks(text);
  const normalized = written.length > 2 * 20_000 ? written : written.replace(/\r\n?/g, "\n");
  if (normalized.length > 20_000 || !normalized.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new HerdrError("invalid_submit_text", "A pending chat message must be nonempty text, at most 20000 characters, without terminal control characters");
  }
  return normalized;
};

const MAX_CHAT_SUBMIT_CHARS = 20_000;
const MAX_TYPED_SUBMIT_CHARS = 32_768;

/**
 * `text` is the message as written: trailing newlines dropped, CRLF and a lone CR read as LF, and no terminal
 * control character but tab and newline, so it holds no paste marker. `payload` must be that text with each LF a CR, bare or inside exactly one bracketed-paste pair:
 * a payload that ends its own paste early, or carries bytes its text does not, would run what follows as
 * commands.
 */
export function submitFraming(text: string, payload: string, typed: boolean): { text: string; payload: string } {
  const written = withoutTrailingBreaks(text);
  const limit = typed ? MAX_TYPED_SUBMIT_CHARS : MAX_CHAT_SUBMIT_CHARS;
  const refusal = (): HerdrError => new HerdrError("invalid_submit_text", `A message must be at most ${limit} characters, without terminal control characters or paste markers, and sent as the composer shapes it; nothing was typed`);
  if (written.length > 2 * limit) throw refusal();
  const message = written.replace(/\r\n?/g, "\n");
  const body = message.replace(/\n/g, "\r");
  if (message.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)
    || (payload !== body && payload !== `\u001b[200~${body}\u001b[201~`)) throw refusal();
  return { text: message, payload };
}

export const pendingFault = (error: unknown, view: HerdrFailureView | undefined) => error instanceof PendingInputError
  ? { code: error.code, message: error.message } : faultOf(error, "submit_failed", view);

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
 * Any other agent's input box whose recorded shape reports typed text (shared/input-row.ts typedDraft), refused
 * with input_draft only when it shows text a person typed: the paste would join it and the Enter send both
 * (#3627). Unlike Claude's and Hermes' checks, a box this read cannot make out is sent to as before, so a
 * misreading never refuses every send to an agent. Claude and Hermes keep their own checks.
 *
 * herdr gives colours for the viewport alone, which any client may have scrolled into the history, so the
 * viewport is read first and the live screen last: the colours count only when their text is the live
 * screen's, and a read without any colour (NO_COLOR, a plain herdr-core read) proves nothing either.
 * `codexScreens`: the live read is also the one Codex's own screens are refused on (freeCodexInput), so a
 * dialog that opens between two checks is not pasted into. Text typed after the live read joins the
 * message: herdr cannot compare and write in one step.
 */
export async function freeAgentInput(paneId: string, agent: string | null, identity?: PendingIdentity, codexScreens = false): Promise<void> {
  if (!readsTypedDraft(agent)) return;
  for (let round = 0; round < AGENT_BOX_READS; round++) {
    const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
    const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    if (codexScreens && codexOwnScreenOpen(live)) throw new HerdrError("agent_blocked", CODEX_OWN_SCREEN_MESSAGE);
    if (!drawsColour(colors)) return;
    if (!showsLive(colors, live)) continue;
    const screen = screenFromAnsi(colors);
    const typing = agent === "pi" && inputRowState("omo", screen) !== "gone" ? "omo" : agent;
    if (typedDraft(typing, screen)) throw new InputDraftError(null, identity, null, AGENT_INPUT_DRAFT_MESSAGE);
    return;
  }
}

const AGENT_BOX_READS = 3;

/**
 * Whether the viewport's read shows the live screen: its rows are the live screen's last ones. herdr's live read can
 * hold a row more at its top than the viewport (measured with Gemini CLI 0.68.0), never other rows at the bottom.
 */
function showsLive(colors: string, live: string): boolean {
  const shown = screenText(colors).split("\n"), current = screenText(live).split("\n");
  return shown.length <= current.length && shown.length >= current.length - 2 && current.slice(current.length - shown.length).join("\n") === shown.join("\n");
}

const screenText = (text: string): string => stripVTControlCharacters(text).split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trimEnd();

/**
 * herdr reports Codex at rest
 * with one of its own screens up (a list such as `/model` or `/permissions`, `/rename`'s field, the `/diff` pager:
 * dialogs/codex.ts codexOwnScreenOpen), so agent.prompt would paste the message there and its Enter would take the
 * row under the cursor.
 * herdr cannot compare and write in one step: a screen that opens during this read's
 * answer or herdr's write is not seen.
 */
export async function freeCodexInput(paneId: string): Promise<void> {
  if (codexOwnScreenOpen((await paneRead({ paneId, source: "detection", format: "text" })).text)) {
    throw new HerdrError("agent_blocked", CODEX_OWN_SCREEN_MESSAGE);
  }
}

export const AGENT_PICKER_MESSAGE = "The agent is waiting for an answer to its own menu; answer the card above, then send";

/**
 * herdr reports an agent no reader knows at rest under a picker of its own (Devin's and Copilot's folder trust at start), so agent.prompt would paste
 * the message there and its Enter would pick the row under the cursor ("Yes, trust"), losing the message.
 */
export async function freeAgentPicker(paneId: string, agent: string): Promise<void> {
  if (agentPickerWaits(agent, (await paneRead({ paneId, source: "detection", format: "text" })).text)) {
    throw new HerdrError("agent_blocked", AGENT_PICKER_MESSAGE);
  }
}

/**
 * herdr reports Claude Code idle with its rewind dialog up, which shows no input box: on a Summarize row the message
 * and its Enter would go to the add-context field and summarize the conversation.
 */
export async function claudeBoxReads(paneId: string): Promise<[string, string | null]> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (claudeRewindOpen(before)) throw new HerdrError("rewind_dialog_open", CLAUDE_REWIND_OPEN_MESSAGE);
  if (!claudeInputDraft(before, null)) return [before, null];
  const scrollBefore = await paneScrollInfo(paneId);
  // a viewport scrolled into the history (any client's scroll is every client's) shows no live box:
  // the history's last rows do, colors included, so Claude's grey suggestion is still told from a draft
  if (scrollBefore !== null && scrollBefore.offset_from_bottom > 0) {
    const recent = async (): Promise<string> => (await paneRead({ paneId, source: "recent", format: "ansi", lines: scrollBefore.viewport_rows })).text;
    const colors = await recent();
    const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    // read again last, after the live screen: equal words do not prove equal colors (a suggestion
    // accepted with Tab keeps its words), so any change across the reads refuses as a draft does.
    const colorsAfter = await recent();
    if (historyEndShowsLive(colors, colorsAfter, [before, live])) return [live, colors];
    if (claudeRewindOpen(stripVTControlCharacters(colorsAfter))) throw new HerdrError("rewind_dialog_open", CLAUDE_REWIND_OPEN_MESSAGE);
    throw new ClaudeBoxMovedError(null, undefined, claudeSendAnywayBox(live), claudeRefusalMessage(live));
  }
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  return [live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null];
}

/**
 * Claude puts the chat's last message back as typed text when the send right after it is cancelled.
 * Two Esc presses empty that copy; Ctrl+C would arm "press Ctrl-C again to exit".
 * An `automatic` send (a queued message, whether the drain or its own request types it) refuses over that copy too: the user stopped
 * that send, and the composer gets it back only from its next prompt read, seconds after the drain.
 * `authorize` throws once the sender may no longer send: it is asked before each Esc, and again
 * right before herdr is written to. A send with less than RESTORED_CLEAR_RESERVE_MS left before its
 * `deadline` clears nothing: it would erase the copy, then time out without sending.
 */
export async function freeClaudeBox(paneId: string, working: boolean, authorize: () => void, deadline: number, automatic = false): Promise<void> {
  let refused: unknown;
  const allowed = (): boolean => { try { authorize(); return true; } catch (error) { refused = error; return false; } };
  const refusal = (error: unknown): never => { throw refused ?? error; };
  const [live, colors] = await claudeBoxReads(paneId);
  if (!claudeInputDraft(live, colors)) return;
  if (working || automatic || claudeRestoredDraft(live, colors, lastChatSubmitted(paneId)) === null) {
    throw new InputDraftError(claudeClearableDraft(live, colors), undefined, claudeSendAnywayBox(live), claudeRefusalMessage(live));
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

/**
 * A masked prompt on `screen` at any width it could be wrapped at. A send need not be attached, and an attachment's width
 * can change during the read, so the widths tried are every one at which the row above the last reaches the right edge
 * (secretPrompt joins only such a row): fail closed rather than trust a width the screen was not drawn at.
 */
function maskedPromptAtAnyWidth(screen: string): boolean {
  const rows = screen.split(/\r?\n/u);
  while (rows.length > 0 && !rows.at(-1)!.trim()) rows.pop();
  const above = displayWidth(rows.at(-2)?.trimEnd() ?? "");
  return [Infinity, ...(above > 0 ? [above, above + 1] : [])].some((columns) => secretPrompt(screen, columns) !== null);
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
   *
   * A working Grok queues that Enter. Only a Send now (`sendNow`: a saved copy's resend) then
   * sends one more Enter, and only while the message is the one row queued (sendGrokQueuedNow).
   * A plain Send, an idle Grok, and the terminal's own input line keep the single Enter.
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
    clearDraft?: string, confirmation?: { draft: string | null; identity: PendingIdentity; box?: string | null }, sendAnyway = false, agentOnly = false,
    sendNow = false): Promise<void> {
    ({ text, payload } = submitFraming(text, payload, fromTerminal));
    let clearedDraft = false;
    let sentText = text;
    let command: ReturnType<typeof prepareCommandSend>;
    let beforeScreen: string | undefined;
    let pickerAgent: string | undefined;
    let grokSendNow: { target: PendingIdentity; before: GrokBeforeSend } | undefined;
    let seen: ProcessInfo | undefined;
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
    const refusal = (error: unknown): never => { throw refused ?? error; };
    /**
     * Send now's one more Enter for a Grok that queued the message (sendGrokQueuedNow), only on a fresh read of the
     * Grok terminal and session the send began in. The queue Enter already landed, so a failure here is submit_changed,
     * never "nothing was typed", or chat would type it again.
     */
    const confirmGrokQueue = async (message: string): Promise<void> => {
      if (fromTerminal || grokSendNow === undefined) return;
      const { target, before } = grokSendNow;
      await sendGrokQueuedNow({
        message,
        before,
        delayMs: options.submitDelayMs ?? SUBMIT_DELAY_MS,
        look: async () => {
          const latest = await paneGet(paneId);
          inTime();
          // a Grok restarted in the pane (another session) has a queue of its own: nothing goes into it
          const now = pendingIdentity(latest);
          if (now.agent !== "grok" || now.terminalId !== target.terminalId || now.session !== target.session) {
            throw new HerdrError("submit_changed", GROK_SEND_UNCONFIRMED_MESSAGE);
          }
          const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
          inTime();
          return { status: latest.agent_status, screen };
        },
        sendEnter: async () => {
          inTime();
          await paneSendKeys(paneId, ["Enter"], undefined, mayType);
        },
      });
    };
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    // fixed wait: herdr holds a lone ESC typed through the attach pty and says nothing when it lets go
    if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
    lastTyped.delete(paneId);
    inTime();
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
          const box = claudeSendAnywayBox(reads[0]);
          if (claudeInputDraft(...reads) && (box === null || box !== confirmation!.box)) throw new InputDraftError(claudeClearableDraft(...reads), identity ?? undefined, box, claudeRefusalMessage(reads[0]));
          const now = pendingIdentity(await paneGet(paneId));
          inTime();
          if (now.agent !== "claude" || now.terminalId !== confirmation!.identity.terminalId || now.session !== confirmation!.identity.session) {
            throw new HerdrError("pending_target_changed", "The refused message's Claude terminal or session changed; nothing was sent");
          }
        }
        const labelledClaude = pane && resolveAgent(pane).agent === "claude" ? await paneProcessRoots(pane.pane_id, "claude") : null;
        const claudeRoots = labelledClaude && resolveAgent(pane!, typingRoots(labelledClaude)).agent === "claude" ? labelledClaude : null;
        const claude = claudeRoots !== null;
        seen = claudeRoots?.processes;
        // the process lookup waited on herdr: the device may have lost its access meanwhile
        inTime();
        if (claude && !sendAnyway) {
          if (clearDraft === undefined) {
            try {
              await freeClaudeBox(paneId, pane?.agent_status === "working", authorize, arrivedAt + (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS));
            } catch (error) {
              if (error instanceof InputDraftError) throw new InputDraftError(error.draft, identity ?? undefined, error.box, error.message);
              throw error;
            }
          }
          let reads = await claudeBoxReads(paneId);
          inTime();
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
            if (clearDraft === undefined || draft !== clearDraft) throw new InputDraftError(draft, identity ?? undefined, clearDraft === undefined ? claudeSendAnywayBox(reads[0]) : null, claudeRefusalMessage(reads[0]));
            const reserve = DRAFT_CLEAR_WAIT_MS + 500;
            inTime(reserve);
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
            const stillDraft = async (): Promise<boolean> => {
              try { await clearScreenReady(); } catch (error) { if (error instanceof ClaudeBoxMovedError) return true; throw error; }
              return claudeInputDraft(...reads);
            };
            for (const deadline = Date.now() + DRAFT_CLEAR_WAIT_MS; await stillDraft();) {
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
          pane = await untilOmpReported(paneId, pane, inTime, options);
          // the last look waited on herdr: the device may have lost its access meanwhile
          inTime();
        }
        if (pane) command = prepareCommandSend(pane, text, beforeScreen);
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
        // a message for an agent alone goes whole through agent.prompt (#511): typing it key by key checks the agent
        // between writes, never with them, so its @skills stay text, as its send says
        if (agentOnly && command) command = skillsNotAttached(command, skills);
        if (pane && command && skills.length > 0 && !agentOnly) {
          const expected = pendingIdentity(pane);
          let current = pane;
          // as the queued path does (pending.ts): no key goes into a masked prompt that came up on the live screen
          const noMaskedPrompt = async (screen?: string): Promise<void> => {
            if ((screen !== undefined && maskedPromptAtAnyWidth(stripVTControlCharacters(screen)))
              || maskedPromptAtAnyWidth((await paneRead({ paneId, source: "detection", format: "text" })).text)) {
              throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
            }
            inTime();
          };
          const revalidate = async (): Promise<void> => {
            current = await paneGet(paneId);
            inTime();
            const now = pendingIdentity(current);
            if (now.agent !== expected.agent || now.terminalId !== expected.terminalId || now.session !== expected.session) {
              throw new HerdrError("pending_target_changed", "The pane's terminal or agent session changed; nothing more was typed");
            }
            if (current.agent_status === "blocked") throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
            await noMaskedPrompt();
          };
          const watch = startOpenCodeWatch(pane, command, options.openCodeStateDir);
          await revalidate().catch((error: unknown) => { watch?.cancel(); throw error; });
          let typed = false;
          const allowed = (): boolean => {
            try { inTime(); return true; } catch (error) { refused = error; return false; }
          };
          const io = herdrSkillAttachIo(paneId);
          const writes: SkillAttachIo = {
            ...io,
            sendText: (piece, guard) => io.sendText(piece, () => guard() && (typed = true)),
            sendKeys: (keys, guard) => io.sendKeys(keys, () => guard() && (typed = true)),
          };
          try {
            const typing = typeWithSkills(text, skills, allowed, writes, revalidate, noMaskedPrompt);
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
        // the last read before herdr is written to: one of Codex's own screens gets no paste and no Enter
        // and what a person typed into the agent's own box, which the paste would join (Claude's and Hermes' were read
        // above): for Codex both on the same last read
        const boxAgent = pane && labelledClaude && !claude ? resolveAgent(pane, typingRoots(labelledClaude)).agent : agent;
        if (pane && !claude && !hermes && readsTypedDraft(boxAgent)) {
          await freeAgentInput(paneId, boxAgent, identity ?? undefined, boxAgent === "codex");
          inTime();
        } else if (agent === "codex") await freeCodexInput(paneId);
        if (agent && !SCREEN_READ_AGENTS.has(agent)) {
          pickerAgent = agent;
          await freeAgentPicker(paneId, agent);
        }
        // a plain Send queues behind a working Grok's turn, as typing in the terminal does: only Send now goes ahead
        if (sendNow && agent === "grok" && pane) {
          const latest = await paneGet(paneId);
          inTime();
          if (resolveAgent(latest).agent === "grok") {
            const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
            inTime();
            grokSendNow = { target: pendingIdentity(latest), before: { working: latest.agent_status === "working", queue: grokQueue(screen), echo: grokEcho(screen) } };
          }
        }
        const watch = pane ? startOpenCodeWatch(pane, command, options.openCodeStateDir) : null;
        try {
          inTime();
          const sentAt = Date.now();
          const delivery = agentPrompt(paneId, closeMention(sent), undefined, mayType);
          bindCommandProcess(paneId, command, seen, pane);
          await delivery;
          // herdr's prompt already sent the Enter that queues a working Grok's follow-up. A failure
          // here must not fall through to another paste: the message is already in Grok's queue.
          await confirmGrokQueue(closeMention(sent));
          noteSubmitted(paneId, sent, recorded(command), sentAt);
          if (command) watch?.commit(command, [{ pasted: closeMention(sent) }], []);
          return;
        } catch (error) {
          watch?.cancel();
          // a revoked sender after the queue Enter is submit_changed, not the refusal from before the write
          if (error instanceof HerdrError && error.code === "submit_changed") throw error;
          if (refused !== undefined) throw refused;
          if (!(error instanceof HerdrError)) throw error;
          if (clearDraft !== undefined || sendAnyway) throw error;
          // a message for an agent alone (#511) is never typed into what is there once the agent has gone
          if (agentOnly && (error.code === "agent_not_found" || error.code === "agent_not_ready")) throw new HerdrError("agent_not_ready", NO_AGENT_MESSAGE);
          // nor typed past a collapsed queue: herdr cannot type only if the agent still runs, and Codex may exit first
          const queuedOnly = !agentOnly && error.code === "agent_blocked" && await blockedOnlyByCodexQueue(paneId);
          if (error.code !== "agent_not_found" && error.code !== "agent_not_ready" && !queuedOnly) throw error;
        }
      }
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
      const shaped = await mirrorInput(closeMention(payload), async () => await terminalAttach() ? null : await paneAgentOf(paneId));
      if (pickerAgent !== undefined) await freeAgentPicker(paneId, pickerAgent);
      inTime();
      await paneSendText(paneId, shaped, undefined, mayType).catch(refusal);
      // fixed wait: a TUI busy with the paste takes an Enter in the same chunk for a newline (SUBMIT_DELAY_MS)
      await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
      authorize();
      const sentAt = Date.now();
      await paneSendKeys(paneId, ["Enter"], undefined, mayType).catch(refusal);
      if (!fromTerminal) await confirmGrokQueue(closeMention(sentText));
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
