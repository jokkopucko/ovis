/**
 * The composer sends "one message", but the pane's
 * program defines what a safe submission is, so the payload follows the pane's own
 * bracketed-paste mode (term.modes.bracketedPasteMode):
 * - mode on (agent TUIs): the text goes out as ONE bracketed paste - newlines stay
 *   literal inside the message - and a bare CR submits it, exactly like paste+Enter.
 * - mode off (plain shell): classic paste semantics - every newline submits its own
 *   line, and the trailing CR runs the last one.
 */

import { withoutTrailingBreaks } from "../../shared/launch-rules.ts";
import type { AgentStatus, CommandForm, ConversationTurn, SlashCommand } from "../../shared/protocol.ts";
import { skillSyntax } from "../../shared/skill-syntax.ts";
import { knownStatus, STATUS_WORD } from "./status.ts";
import { t, type Vars } from "./i18n.ts";
import type { ActiveTrigger } from "./mentions.ts";
import { AGENT_INPUT_DRAFT_MESSAGE, CLAUDE_FOLDED_DRAFT_MESSAGE, GROK_QUEUED_MESSAGE, grokQueuedAhead, NO_AGENT_MESSAGE, submitNotTyped } from "../../shared/submit-outcome.ts";
export { submitNotTyped } from "../../shared/submit-outcome.ts";

/** This cap keeps one composer message inside a single WS frame. */
export const MAX_COMPOSER_CHARS = 20_000;

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * A composer message as written: trailing newlines are the composer's, not the text's; CRLF reads as one newline.
 * A whole paste marker pasted into it is dropped (until none is left, so dropping one cannot form another): it would
 * end the paste the message goes in early. Any other escape byte stays, and the bridge refuses the message for it.
 * One pass: each marker goes the moment its last byte arrives, so one that dropping another forms goes too.
 */
export function composerMessage(text: string): string {
  const kept: string[] = [];
  for (let i = 0; i < text.length; i++) {
    kept.push(text[i]!);
    const from = kept.length - PASTE_START.length;
    if (from >= 0 && kept[from] === "\u001b" && (kept.slice(from).join("") === PASTE_START || kept.slice(from).join("") === PASTE_END)) kept.length = from;
  }
  return withoutTrailingBreaks(kept.join("")).replace(/\r\n?/g, "\n");
}

export function composerPayload(text: string, bracketedPaste: boolean): string {
  const body = composerMessage(text).replace(/\n/g, "\r");
  return bracketedPaste ? PASTE_START + body + PASTE_END : body;
}

export function insertNote(code: string, message: string): string {
  if (code === "unsupported") return t("Update this PC to insert without Enter. Nothing was sent.");
  if (code === "read_only") return t("Not inserted: this view only watches the pane.");
  if (code === "unsafe_multiline") return t("Insert takes one line. Send several lines, or insert them one at a time.");
  if (code === "insert_too_long") return t("Not inserted: the text is too long for the terminal.");
  if (code === "secret_prompt") return t("Not inserted: the terminal is asking for a password. Nothing was typed.");
  if (code === "held_input") return t("Not sent: send or discard the held input first.");
  if (code === "not_transmitted") return t("Not inserted: the connection dropped before the text left. Try again.");
  if (code === "insert_timeout") return t("Not inserted: it waited too long behind earlier input, and nothing was typed. Try again.");
  if (code === "capabilities_unknown") return t("Not inserted: this PC has not said yet what it supports. Insert it again.");
  if (code === "invalid_insert_text") return t("Not inserted: the line holds a control character. Remove it, then insert again.");
  if (["input_not_ready", "not_attached", "attach_held", "pane_read_failed"].includes(code)) return t("Not inserted: the terminal is not ready. Nothing was typed.");
  if (code === "disconnected" || code === "timeout" || code === "insert_failed") return t("Not confirmed: the terminal did not confirm the text. Check it before inserting again.");
  return t("Not inserted: {message}", { message });
}

/**
 * An action whose frame never left (`not_transmitted`) proves only that a held row was not sent: a queued row may still
 * be typed by its turn's end, since the bridge keeps its lease until it notices the connection is gone.
 */
export function pendingActionUncertain(code: string, state: string): boolean {
  if (code === "not_transmitted") return state !== "held";
  return code === "pending_not_found" || !submitNotTyped(code);
}

export type DraftRefusal = { note: string; draft: string } | { note: string; anyway: true; plain?: boolean };

export function submitRefusal(code: string, message: string, draft?: string, box?: string, agent?: string | null): string | DraftRefusal {
  if (code === "input_draft" && draft) return { note: t("Not sent: Claude Code's input box in the terminal already holds “{draft}”.", { draft }), draft };
  if (code === "input_draft" && box) return { note: t("Not sent: Claude Code's input box in the terminal may not be empty. It shows “{box}”.", { box }), anyway: true };
  return submitNote(code, message, agent);
}

export function draftSendNote(result: string | DraftRefusal, draft: string): string | DraftRefusal {
  if (typeof result !== "string" && "draft" in result) return result;
  const note = typeof result === "string" ? result : "plain" in result && result.plain === true ? result.note : submitNote("input_draft", result.note);
  return `${note}\n${t("Draft: “{draft}”", { draft })}`;
}

export function sameMessage(a: string, b: string): boolean {
  const bare = (text: string): string => text.replace(/[\s\u00a0]+/gu, "");
  return bare(a) !== "" && bare(a) === bare(b);
}

export type TurnIdentity = { ts: string | null; text: string };

const userText = (turn: ConversationTurn): string => turn.parts
  .filter((part): part is Extract<ConversationTurn["parts"][number], { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n");

export function stoppedTurn(turns: readonly ConversationTurn[], restored: string | null): TurnIdentity | null {
  const last = turns.at(-1);
  if (restored === null || last?.role !== "user") return null;
  const text = userText(last);
  return sameMessage(text, restored) ? { ts: last.ts, text } : null;
}

export function endsWithTurn(turns: readonly ConversationTurn[], turn: TurnIdentity | null): boolean {
  const last = turns.at(-1);
  return turn !== null && last?.role === "user" && last.ts === turn.ts && userText(last) === turn.text;
}

/** Agent names in this server refusal are JSON strings, so custom names cannot confuse the fields. */
export function openCodeAgentChange(message: string): { from: string; to: string } | null {
  const match = /^Tab switched OpenCode's agent from ("(?:[^"\\]|\\.)*") to ("(?:[^"\\]|\\.)*")\. Nothing more was typed\.$/u.exec(message);
  if (!match) return null;
  try {
    const from: unknown = JSON.parse(match[1]!);
    const to: unknown = JSON.parse(match[2]!);
    return typeof from === "string" && typeof to === "string" ? { from, to } : null;
  } catch {
    return null;
  }
}

export function openCodeRefusalNote(code: string, message: string, tt: (text: string, vars?: Vars) => string = t): string | null {
  if (code !== "submit_changed") return null;
  const changed = openCodeAgentChange(message);
  if (changed) return tt("Tab switched OpenCode's agent from {from} to {to}. Nothing more was typed. Check the terminal before sending again.", changed);
  if (message === "OpenCode attached another skill. Your chat text stayed here. Check the terminal before sending again.") return tt("OpenCode attached another skill. Your chat text stayed here. Check the terminal before sending again.");
  return null;
}

/**
 * The note for a Send now a working Grok kept in its queue (server/core/grok-queue.ts sendGrokQueuedNow), on the row it
 * leaves uncertain: the message is in Grok's queue, not "not sent", and the row offers no Send now that would queue it
 * twice.
 */
export function grokQueueNote(code: string, message: string, tt: (text: string, vars?: Vars) => string = t): string | null {
  if (code !== "submit_changed") return null;
  const ahead = grokQueuedAhead(message);
  if (ahead !== null) return tt("In Grok's queue behind {count} queued before it; it goes when they do. Nothing more was pressed. This copy stays here to read and is not sent again.", { count: ahead });
  if (message === GROK_QUEUED_MESSAGE) return tt("In Grok's queue; it goes when Grok gets to it. Nothing more was pressed. This copy stays here to read and is not sent again.");
  return null;
}

export function submitNote(code: string, message: string, agent?: string | null): string {
  const opencode = openCodeRefusalNote(code, message);
  if (opencode !== null) return opencode;
  if (code === "submit_partial") return t("Not confirmed: the terminal draft was cleared or may have changed. Your message stayed here. Check the terminal before sending again.");
  if (code === "pasted_not_sent") return t("Not sent: the message is in the terminal's input line. Clear it there, or press Enter there to send it.");
  if (code === "agent_blocked") return t("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
  if (code === "read_only") return t("Not sent: this view only watches the pane.");
  if (code === "held_input") return t("Not sent: send or discard the held input first.");
  if (code === "input_draft" && agent === "hermes") return t("Not sent: Hermes' input in the terminal is not empty. Send or clear it there, then send this message.");
  if (code === "input_draft" && message === CLAUDE_FOLDED_DRAFT_MESSAGE) return t("Not sent: Claude Code's input box in the terminal holds a paste or image it folded, whose lines are not shown here, so it cannot be sent over. Send or clear it there, then send this message.");
  // any other agent's box, refused only over text typed there (server/core/composer.ts freeAgentInput); its message
  // names it also where the pane is labelled Claude Code (an OmO with its Claude SDK child)
  if (code === "input_draft" && (message === AGENT_INPUT_DRAFT_MESSAGE || (agent != null && agent !== "claude"))) return t("Not sent: the agent's input box in the terminal holds text typed there. Send or clear it there, then send this message.");
  if (code === "input_draft") return t("Not sent: Claude Code's input box in the terminal is not empty. Send or clear it there, then send this message.");
  if (code === "rewind_dialog_open") return t("Not sent: Claude Code's rewind dialog is open in the terminal. Finish or close it there (Esc), then send this message.");
  if (code === "pending_input_unsupported") return t("Update this PC to send messages in the next turn. Your draft stayed here.");
  if (code === "pending_hold_unsupported") return t("Update this PC to hold messages. Your draft stayed here.");
  // #511: a message with comments on a reply goes only to an agent
  if (code === "agent_only_unsupported") return t("Update this PC to send comments on a reply. Your message and comments stayed here.");
  if (code === "agent_not_ready" && message === NO_AGENT_MESSAGE) return t("Not sent: no agent is running in this pane. Your message stayed here.");
  if (code === "submit_timeout") return t("Not sent: it waited too long behind an earlier message, and nothing was typed. Send it again.");
  if (code === "not_transmitted") return t("Not sent: the connection dropped before this message left. Send it again.");
  if (code === "capabilities_unknown") return t("Not sent: this PC has not said yet what it supports. Send it again.");
  if (code === "first_message_unattended") return t("Not sent: the page that started this agent left before it was ready. Send it now or discard it.");
  if (code === "first_message_launch_ended") return t("Not sent: the agent started for this message has ended. Review the message before sending it.");
  if (code === "pending_target_changed") return t("Not sent: the pane's terminal or agent session changed. Review the message before sending it again.");
  if (code === "typed_while_waiting") return t("Not sent: something was typed in the terminal while omp was starting. Check its input line there, then send this message.");
  if (code === "disconnected" || code === "timeout") return t("Not confirmed: the pane did not confirm this message. Check the terminal before sending it again.");
  return t("Not sent: {message}", { message });
}

/**
 * How a stored image is referenced in the prompt: the agent TUI reads the file from
 * its path, so the mention is plain text the user can still edit before sending.
 */
export function imageMention(path: string): string {
  return `@${path} `;
}

/**
 * Where an attached file's mention goes: at the start of the message, after a leading `/command`
 * (it must stay first to be one), and after the mentions of files picked before it in the same
 * batch that are still there, so a batch reads in pick order however its uploads finish. The mention goes in
 * whole, with its separating space, or not at all (`length` 0): a cut `@path` would name a file
 * that does not exist, so the caller keeps the attachment waiting until there is room; `missing`
 * says how many characters the message is short of it.
 */
export function insertLeadingMention(
  text: string,
  mention: string,
  earlier: readonly string[],
): { text: string; at: number; length: number; missing?: number } {
  let at = /^\/\S+\s*/u.exec(text)?.[0].length ?? 0;
  for (const previous of earlier) {
    const found = text.indexOf(previous);
    if (found >= 0) at = Math.max(at, found + previous.length);
  }
  const before = text.slice(0, at);
  const snippet = before.length > 0 && !/\s$/u.test(before) ? ` ${mention}` : mention;
  const missing = text.length + snippet.length - MAX_COMPOSER_CHARS;
  if (missing > 0) return { text, at, length: 0, missing };
  return { text: before + snippet + text.slice(at), at, length: snippet.length };
}

/** Ready states affect the held-message hint only; sending always requires a user action. */
export const QUEUE_READY_STATUS: Readonly<Partial<Record<string, true>>> = { done: true, idle: true };

/**
 * The agent's own menu hides an `agent-hidden` row (Claude's agents,
 * heapdump, setup-bedrock), and this one mirrors it: never listed, and typed by hand it is sent
 * like any other text.
 */
export function commandListed(command: SlashCommand): boolean {
  return command.visibility !== "agent-hidden";
}

function paletteCommandListed(command: SlashCommand): boolean {
  return commandListed(command) && (!command.chatPaletteHidden || terminalCommand(command)
    || (command.forms ?? []).some((form) => form.match === "bare" && form.interaction === "dialog" && form.dialog !== undefined));
}

/** A row left out of the palette whose whole name was typed: the menu stays out of the way, so Enter sends it as typed. */
function namesPaletteHidden(commands: readonly SlashCommand[], word: string, prefix: string | undefined): boolean {
  return word !== "" && commands.some((command) => commandListed(command) && !paletteCommandListed(command)
    && (prefix === undefined || (command.trigger ?? "/") === prefix) && command.name.toLowerCase() === word);
}

export function namesHiddenCommand(commands: readonly SlashCommand[], query: string, prefix?: string): boolean {
  const word = query.toLowerCase();
  return word !== "" && (namesPaletteHidden(commands, word, prefix) || commands.some((command) => !commandListed(command)
    && (prefix === undefined || (command.trigger ?? "/") === prefix)
    && command.name.toLowerCase().startsWith(word)));
}

/**
 * A command the agent runs in the terminal, which the chat can start but cannot finish: the
 * catalog says so (`visibility: "terminal"`, or a bare form whose interaction is the terminal,
 * as pi's and omp's `/tree` browser or Claude's `/config` screen).
 */
export function terminalCommand(command: SlashCommand): boolean {
  if (!commandListed(command)) return false;
  return command.visibility === "terminal" || (command.forms ?? []).some((form) => form.match === "bare" && form.interaction === "terminal");
}

/**
 * A stray argument to a command that takes none is still that
 * command typed (`/tree w13:p2` opens the tree), so the bare form answers for it too.
 */
function typedForm(command: SlashCommand, argument: string): CommandForm | undefined {
  const forms = command.forms ?? [];
  const bare = forms.find((form) => form.match === "bare");
  if (argument === "") return bare;
  const sub = argument.split(/\s+/u)[0]!.toLocaleLowerCase();
  return forms.find((form) => typeof form.match === "object" && form.match.sub.toLocaleLowerCase() === sub)
    ?? forms.find((form) => form.match === "other")
    ?? bare;
}

/**
 * The form it was typed in decides where the catalog tells forms apart: `/model` may open a dialog
 * while `/model sonnet` needs nothing, and only `/resume list` may need the terminal.
 */
export function typedTerminalCommand(commands: readonly SlashCommand[], text: string): SlashCommand | null {
  const match = /^([/$])([^\s/$]\S*)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const [, trigger, word, argument = ""] = match;
  const name = word!.toLocaleLowerCase();
  const command = commands.find((row) => commandListed(row) && (row.trigger ?? "/") === trigger && row.name.toLocaleLowerCase() === name);
  if (command === undefined) return null;
  if (command.visibility === "terminal") return command;
  return typedForm(command, argument.trim())?.interaction === "terminal" ? command : null;
}

/** The pane's `@` skills (OpenCode v2 attachments), listed in the `@` menu beside the files; none for other panes. */
export function atSkillCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((command) => command.trigger === "@" && commandListed(command));
}

/** What picking an `@` skill inserts: `@` and its name, the skill id OpenCode expects (the row's `id` is its file's path). */
export function atSkillReplacement(command: SlashCommand): string {
  return `@${command.name} `;
}

export function composerStatusWord(status?: AgentStatus): string {
  const known = knownStatus(status);
  return known === "unknown" ? "READY" : STATUS_WORD[known];
}

/**
 * Below this card width the controls row cannot hold the background-task chip's words beside the
 * model, the effort and the offline sentence, so the chip shows its icon and count instead.
 * The input card is at most 820px wide (`--content-w`); a 1024px window with the sidebar open
 * still has a 672px card and keeps the words, a 940px one has 588px and gives them up.
 */
export const COMPOSER_STATUS_COMPACT_BELOW = 640;

export function composerStatusCompact(cardWidth: number): boolean {
  return cardWidth > 0 && cardWidth < COMPOSER_STATUS_COMPACT_BELOW;
}

export function composerSendShown(state: { working: boolean; text: string }): boolean {
  return !state.working || state.text.trim().length > 0;
}

/**
 * `cardWaits`: the PC's server also shows a pane blocked while it reads a card its agent did not report (herdr-core,
 * server/card-waits.ts). That agent may still be working, and nothing the page gets tells such a wait from the
 * agent's own blocked: a message for it waits as one for a working agent does. An agent that reports blocked
 * itself takes no message either way: the server refuses it at once or queued alike.
 */
export function composerDelivery(agent: string | null, status?: AgentStatus, cardWaits = false): "queue" | "immediate" {
  return agent !== null && (status === "working" || (cardWaits && status === "blocked")) ? "queue" : "immediate";
}

/**
 * Whether Claude can take a message now, whatever herdr reports. herdr's Claude manifest reads a
 * braille spinner in the window title (osc_title_working, 1100) and "Waiting for N background agents
 * to finish" (background_agents_working, 965) as working, both above the idle prompt box
 * (live_prompt_box, 950): a main agent that ended its turn while a subagent it started still runs is
 * reported as working, and the composer holds the message.
 */
export function claudeMainAtRest(row: string | null, lines: readonly string[]): boolean {
  if (row !== "ready") return false;
  const rule = (line: string): boolean => /^[─━]{8,}$|^─{2,}\s.*─$/u.test(line.trim());
  let lower = lines.length - 1;
  while (lower >= 0 && !rule(lines[lower]!)) lower--;
  if (lower < 0) return false;
  let upper = lower - 1;
  while (upper >= 0 && !rule(lines[upper]!)) upper--;
  if (upper < 0) return false;
  const above = lines.slice(0, upper);
  if (!above.some((line) => /^\s*Waiting for [1-9]\d* background agents? to finish\s*$/u.test(line))) return false;
  for (const line of above) {
    if (/esc to (?:interrupt|cancel)/i.test(line)) return false;
    if (/^\s*(?:[*·✢✳✶✻✽●◐◓◑◒]\s+)?Compacting\b/iu.test(line)) return false;
    if (/^\s*[*·✢✳✶✻✽●◐◓◑◒]\s+\S.*(?:…|\.{3}|\(\d+(?:\.\d+)?[smh](?:\s|[)·]))/u.test(line)) return false;
  }
  return true;
}

export const COMPOSER_CHARS_WARNING = 200;

export function composerStatusHint(state: { uploading: boolean; connected: boolean; text: string; noRoom?: boolean }): "uploading" | "offline" | "no-room" | "near-limit" | null {
  if (!state.connected && state.text.length > 0) return "offline";
  if (state.noRoom) return "no-room";
  if (state.uploading) return "uploading";
  return MAX_COMPOSER_CHARS - state.text.length <= COMPOSER_CHARS_WARNING ? "near-limit" : null;
}

export type ComposerModelDraw = "full" | "no-effort" | "out";

export function composerModelDraw(state: { modelClipped: boolean; effortClipped: boolean }): ComposerModelDraw {
  if (!state.modelClipped && !state.effortClipped) return "full";
  return "no-effort";
}

export function agentDisplayLabel(agent: string | null): string {
  if (!agent) return "Shell";
  if (agent === "dsh" || agent === "dsh-tui") return "DeepSeek Harness";
  return agent
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slashMatchTier(command: SlashCommand, needle: string, prefixOnly: boolean): number | null {
  if (needle === "") return 0;
  const name = command.name.toLocaleLowerCase();
  if (name.startsWith(needle)) return 0;
  const first = name.indexOf(needle);
  for (let position = first; position >= 0; position = name.indexOf(needle, position + 1)) {
    if ((prefixOnly ? /[:-]/u : /[:\-_./]/u).test(name[position - 1]!)) return 1;
  }
  if (prefixOnly) return null;
  if (first >= 0) return 2;
  let at = 0;
  for (const letter of name) {
    if (needle.startsWith(letter, at)) at += letter.length;
    if (at === needle.length) return 3;
  }
  return needle.length >= 2 && command.description.toLocaleLowerCase().includes(needle) ? 4 : null;
}

export function commandsForTrigger(commands: readonly SlashCommand[], agent: string | null, trigger: ActiveTrigger): SlashCommand[] {
  const syntax = skillSyntax(agent);
  const prefix = trigger.prefix ?? "/";
  if (trigger.start === 0 && namesPaletteHidden(commands, trigger.query.toLowerCase(), prefix)) return [];
  return commands.filter((command) => {
    if (!paletteCommandListed(command)) return false;
    if (trigger.start === 0) {
      return syntax.skillTriggers.length > 1
        ? prefix === "/" || command.source === "skill"
        : (command.trigger ?? "/") === prefix;
    }
    if (command.source !== "skill" || !syntax.inline.includes(prefix)) return false;
    if (agent === "codex") return command.trigger === "$";
    if (agent === "claude") return command.trigger === undefined;
    if (agent === "omp") return command.name.startsWith("skill:");
    return true;
  });
}

export function briefDescription(description: string): string {
  const text = description.trim();
  const end = /[.!?](?=\s+[\p{Lu}\p{Lo}"'(])|\u3002/u.exec(text);
  const brief = end ? text.slice(0, end.index) : text;
  return /[.\u3002]$/.test(brief) && brief[brief.length - 2] !== "." ? brief.slice(0, -1) : brief;
}

export const COMMAND_GROUPS = ["builtin", "user", "project", "skill-user", "skill-project", "skill", "skill-bundled", "skill-plugin", "plugin", "terminal"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export function commandGroup(command: SlashCommand): CommandGroup {
  if (terminalCommand(command)) return "terminal";
  if (command.source === "skill" && command.origin !== undefined) return `skill-${command.origin}`;
  return command.source;
}

/**
 * OpenCode's TUI built-ins that take no argument, which its own menu runs when picked: v2.2.7's `slash` entries without
 * `arguments: true` (packages/tui/src: app.tsx, routes/session, component/prompt, feature-plugins) and v1.19.5's
 * `slashName` entries, which take none. Not here: `cd`, `rename` and `btw`, which v2 types with a space for an argument,
 * and the server's commands (`init`, `review`, custom, project and plugin ones), which its menu only types.
 */
const OPENCODE_BARE_BUILTINS: ReadonlySet<string> = new Set([
  "agents", "clear", "compact", "connect", "copy", "debug", "diff", "editor", "exit", "export", "fork", "help",
  "highlights", "mcps", "models", "move", "new", "open", "org", "pair", "plugins", "redo", "reload", "restart",
  "sessions", "settings", "skills", "stats", "status", "terminal", "themes", "thinking", "timeline", "timestamps",
  "undo", "update", "usage", "variants", "warp", "workspaces", "worktrees",
]);

/**
 * Whether a command picked from the menu and sent unchanged goes without the space the pick put after it. OpenCode runs
 * a built-in that takes no argument only from its own menu, and sends `/new ` as a prompt (#3813). Its other commands
 * only type `/name ` from its menu, and that space is what lets Enter send them, so they keep it, as every other
 * agent's commands do.
 */
export function sendsBarePick(command: SlashCommand, agent: string | null): boolean {
  return agent === "opencode" && command.source === "builtin" && (command.trigger ?? "/") === "/" && OPENCODE_BARE_BUILTINS.has(command.name);
}

export function slashCommandReplacement(command: SlashCommand, agent: string | null, trigger: ActiveTrigger): string {
  const prefix = skillSyntax(agent).skillTriggers.length > 1 ? trigger.prefix ?? "/" : command.trigger ?? "/";
  return `${prefix}${command.name} `;
}

/**
 * Away from line starts, `prefixOnly` excludes fuzzy matches that could rewrite paths such as `/tmp`.
 */
export function rankSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  usage: Readonly<Partial<Record<string, number>>>,
  prefixOnly = false,
): SlashCommand[] {
  const needle = query.toLocaleLowerCase();
  const ranked: { command: SlashCommand; tier: number }[] = [];
  for (const command of commands) {
    const tier = slashMatchTier(command, needle, prefixOnly);
    if (tier !== null) ranked.push({ command, tier });
  }
  return ranked
    .sort((left, right) => {
      const tier = left.tier - right.tier;
      const frequency = (usage[right.command.name] ?? 0) - (usage[left.command.name] ?? 0);
      return tier || frequency || left.command.name.localeCompare(right.command.name);
    })
    .map(({ command }) => command);
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function contextLeftPercent(context: { used: number; window: number | null }): number | null {
  if (context.window === null || context.window <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - context.used / context.window) * 100)));
}
