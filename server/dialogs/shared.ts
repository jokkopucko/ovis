import { type CardText, type InteractivePrompt, type InteractivePromptOption, type InteractivePromptStep } from "../../shared/protocol.ts";
import { type CardTextKey } from "../../shared/card-text.ts";
import { type OpenCodeFormFieldOption, type OpenCodeFormInfo } from "../opencode-service.ts";
import { createHash } from "node:crypto";
import type { ReaderContext } from "./registry.ts";
import type { InteractionPlan } from "./interaction-plan.ts";
import type { PiAskUserForm } from "../pi-ask-bridge.ts";
import type { NativeSteps } from "./step-navigate.ts";

/**
 * A parser that several readers call on the same screen, run once per read: the readers of one
 * parsePrompt pass are given the same screen and the same context object in turn.
 */
export function onePerPass<T>(parse: (screen: string, ctx: ReaderContext) => T): (screen: string, ctx: ReaderContext) => T {
  let last: { screen: string; ctx: ReaderContext; value: T } | null = null;
  return (screen, ctx) => {
    if (last?.screen === screen && last.ctx === ctx) return last.value;
    const value = parse(screen, ctx);
    last = { screen, ctx, value };
    return value;
  };
}

export interface DialogReader {
  id: string;
  agents: readonly string[];
  priority: number;
  /** Result readers must return resultText: a complete, fixture-recorded block. */
  kind?: "result";
  /** Recognize this agent's echoed command line; omitted readers use the standard prompt prefix. */
  echoOf?(line: string, command: string): boolean;
  /** First persistent bottom-chrome line; -1 (or lines.length) means none. Invalid indexes or hidden command echoes reject correlation; parsing keeps valid chrome. */
  chromeStart?(lines: string[]): number;
  /** A result reader's text may end with the next echo line as a completion boundary, never its following output. */
  parse(screen: string, ctx: ReaderContext): ParsedPrompt | null;
  /**
   * When the answer looks at the screen again: before its commit, or also before every move after
   * the first, for a picker that closes onto an input box where the remaining arrows would land
   */
  reread: "each-move" | "before-commit" | "none";
  list: "none" | "letter-window" | "slider";
  interaction?(parsed: ParsedPrompt): InteractionPlan;
}

export const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const SELECTED_RE = /^[❯›>]\s*/;

const DIVIDER_RE = /^[\s╭╮╰╯├┤┬┴┼─━═╌▔]+$/;

export const SOLID_RULE_RE = /^[─━]{8,}$/;

export const NUMBERED_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;

export const KEY = {
  up: "up",
  down: "down",
  enter: "enter",
  escape: "esc",
  space: "space",
  tab: "tab",
  right: "right",
  left: "left",
  backtab: "shift+tab",
  backspace: "backspace",
  // opens Codex's queue on its first question, and closes it back to the main prompt
  // (herdr's own alt+arrow bindings apply to the keyboard, not to keys sent to the pane)
  openQueue: "alt+up",
  closeQueue: "alt+down",
} as const;

type Responder =
  | "codex-question"
  | "codex-async-question"
  | "codex-queued-question"
  | "omp-question"
  | "claude-question"
  | "claude-submit"
  | "codex-menu"
  | "codex-approval"
  | "omp-approval"
  | "claude-approval"
  | "claude-plan"
  | "claude-confirm"
  | "claude-held"
  | "claude-goal"
  | "claude-model"
  | "claude-effort"
  | "codex-model"
  | "omo-question"
  | "omo-review"
  | "omo-typing"
  | "omo-pending"
  | "pi-question"
  | "pi-confirm"
  | "pi-input"
  | "pi-model"
  | "pi-thinking"
  | "pi-ask-question"
  | "pi-ask-submit"
  | "pi-ask-user"
  | "pi-questionnaire-question"
  | "pi-questionnaire-submit"
  | "omo-model"
  | "omp-model"
  | "hermes-question"
  | "hermes-input"
  | "hermes-help"
  | "hermes-status"
  | "hermes-version"
  | "hermes-profile"
  | "hermes-reload-skills"
  | "omp-submit"
  | "omp-handoff"
  | "opencode-question"
  | "opencode-v1-question"
  | "fallback-menu"
  | "fallback-gjc-menu"
  | "fallback-keys"
  | "cmd-question";

export type ParsedPrompt = InteractivePrompt & {
  /** Exact contiguous result block, including its identifying header and completion footer. */
  resultText?: string;
  /** Only a recognized successful catalog reload sets this; never a generic screen delta. */
  catalogChanged?: true;
  responder: Responder;
  /** Stable question identity across the folded widget and the expanded form. */
  omoQuestion?: { call: string; index: number };
  /** The form's questions as its own keys move between them without answering (dialogs/step-navigate.ts). */
  nativeSteps?: NativeSteps;
  openCodeForm?: {
    formId: string;
    fieldKey: string;
    stepIndex: number;
    totalSteps: number;
    options: OpenCodeFormFieldOption[];
    sessionID: string;
    state: OpenCodePromptEntry;
    revision: number;
    available: boolean;
  };
  /** Pi's active tab, from colors verified against the live detection screen by the caller. */
  piAskForm?: { identity: string; index: number };
  /** Claude's AskUserQuestion tab shown, from the tab bar's colors (claude.ts claudeTabSteps); absent without them. */
  claudeTabs?: { identity: string; index: number };
  /** @eko24ive/pi-ask's ask_user form, as the web UI's pi extension reports it (server/pi-ask-bridge.ts). */
  piAskUser?: PiAskUserForm;
  /** Pi's custom row owns the inline editor, rather than only a selected menu row. */
  piAskTyping?: true;
  /** Installed questionnaire editor contents; absent outside its guarded input mode. */
  piQuestionnaireInput?: string;
  piQuestionnaireInputRows?: string[];
  /** omp says it cut the question (server/omp-ask.ts): it fills the panel's four rows and the footer offers to expand it */
  ompQuestionCut?: true;
  /** omp: the pane's one open ask call this card was read under (session and call id, omp-ask.ts), checked again before each key */
  ompCall?: string;
  /** Claude's /effort: the state its Ultracode switch shows, null without one; checked before `s`, never sent */
  claudeUltracode?: boolean | null;
  menuLabels: string[];
  selectedIndex: number;
  checkedOptionIndices: number[];
  customMenuIndex: number | null;
  rejectWithEscapeIndex: number | null;
  /** each option's own steps, for a card whose options are not rows of a menu */
  optionSteps?: AnswerStep[][];
  /** the steps for a typed answer, for a card whose menu does not take one the usual way */
  customSteps?: (text: string) => AnswerStep[];
  /** the steps for a multiple choice, for a card whose menu does not toggle the usual way */
  multiSteps?: (choices: number[]) => AnswerStep[];
  /** the key the menu itself names for the row under the cursor now, for a card whose rows do not all take the same one */
  rowKey?: AnswerStep | null;
};

/** `pick`: the menu's own key for the row the moves end on, read off the screen once the cursor is there (`rowKey`) */
export type AnswerStep = { keys?: string[]; text?: string; pick?: true };

export type MenuRow = { label: string; selected: boolean; checked: boolean; description?: string; lineIndex: number };

export type NumberedRow = MenuRow & { number: number };

export const parsedByPublicPrompt = new WeakMap<InteractivePrompt, ParsedPrompt>();

export function cleanLine(rawLine: string): string {
  let line = rawLine.replace(ANSI_RE, "").trim();
  if (line.startsWith("│")) line = line.slice(1).trimStart();
  if (line.endsWith("│")) line = line.slice(0, -1).trimEnd();
  return line.trim();
}

export function isDivider(line: string): boolean {
  const value = cleanLine(line);
  return Boolean(value) && DIVIDER_RE.test(value);
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function findLastIndex(lines: string[], predicate: (line: string, index: number) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index]!, index)) return index;
  }
  return -1;
}

/**
 * A line and the two after it, as one: a narrow pane wraps a hint line
 * (`Enter to select · ↑/↓ to navigate · Esc to` / `cancel`), so hints are matched
 * across the wrap. The last line a window matches from is where the hint begins.
 */
export function wrapped(lines: string[], index: number, span = 3): string {
  return lines.slice(index, index + span).map(cleanLine).filter((line) => line && !isDivider(line)).join(" ");
}

export function nearestQuestion(lines: string[], beforeIndex: number): string | null {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 14); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!line || isDivider(line) || /^Planning:/i.test(line) || /^[←→].*Submit/i.test(line)
      || /^[☐☑✔]\s+\S/.test(line) || /^Question \d+\/\d+/i.test(line)) continue;
    return line.replace(/^\(\d+\s+selected\)\s*/i, "").trim();
  }
  return null;
}

export function parseNumberedRows(lines: string[], start: number, end: number): NumberedRow[] {
  const rows: NumberedRow[] = [];
  for (let index = start; index < end; index += 1) {
    const match = lines[index]!.replace(ANSI_RE, "").trim().match(NUMBERED_OPTION_RE);
    if (!match) continue;
    let label = match[3]!.trim();
    // Claude Code 2.1.296 ticks a row with ✔, older ones with ✓
    const checked = /^\[[xX✓✔]\]/.test(label);
    label = label.replace(/^\[[ xX✓✔]\]\s*/, "").trim();
    rows.push({ number: Number.parseInt(match[2]!, 10), label, selected: Boolean(match[1]), checked, lineIndex: index });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const nextLineIndex = rows[index + 1]?.lineIndex ?? end;
    // a description a narrow pane wraps goes on to the next blank line or rule
    const description: string[] = [];
    for (let lineIndex = row.lineIndex + 1; lineIndex < nextLineIndex; lineIndex += 1) {
      const line = cleanLine(lines[lineIndex]!);
      if (line && !isDivider(line)) description.push(line);
      else if (description.length > 0) break;
    }
    if (description.length > 0) row.description = normalizeText(description.join(" "));
  }
  return rows;
}

/**
 * A menu's rows among numbered lines read from well above it: the last run that counts up from 1,
 * among the lines numbered in the column of the row the cursor is on. What is above a menu can hold
 * a numbered line of its own, such as a message sent before ("❯ 1. …", "› 1. …") still on screen;
 * a numbered line in an option's description is indented further.
 */
export function menuRows(lines: string[], start: number, end: number): NumberedRow[] {
  const rows = parseNumberedRows(lines, start, end);
  const column = (row: NumberedRow): number => lines[row.lineIndex]!.replace(ANSI_RE, "").search(/\d/);
  // the cursor's row is the menu's (a sent message after the same mark lines up with it); without one, the last row
  const anchor = [...rows].reverse().find((row) => row.selected) ?? rows.at(-1);
  const menu = anchor === undefined ? rows : rows.filter((row) => column(row) === column(anchor));
  return menu.slice(Math.max(0, menu.map((row) => row.number).lastIndexOf(1)));
}

export function sequentialRows(rows: NumberedRow[]): boolean {
  return rows.length > 0 && rows.every((row, index) => row.number === index + 1);
}

/** What a card shows: the agent's own text as read, or the bridge's own words (`own`), which the client shows in the user's language. */
export type CardWords = string | CardText;

/** The bridge's own words on a card (shared/card-text.ts), with the values of their placeholders: given where a card takes the agent's text. */
export function own(key: CardTextKey, vars?: CardText["vars"]): CardText {
  return vars === undefined ? { key } : { key, vars };
}

/** A card's words in English, the bridge's own with their values filled in: as an older client shows them, and as the card's id reads them. */
export function englishOf(words: CardWords): string {
  if (typeof words === "string") return words;
  return words.key.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = words.vars?.[name];
    return value === undefined ? match : typeof value === "object" ? englishOf(value) : String(value);
  });
}

/** A card as a reader writes it: its title, question, body, options and steps may be the bridge's own words. */
export type PromptDraft = Omit<InteractivePrompt, "id" | "agent" | "title" | "question" | "body" | "options" | "steps" | "own_text"> & {
  title: CardWords;
  question: CardWords;
  body: CardWords | null;
  options: (Omit<InteractivePromptOption, "label" | "description"> & { label: CardWords; description: CardWords | null })[];
  steps?: (Omit<InteractivePromptStep, "label"> & { label: CardWords })[];
};

/** The entries of `words` that are the bridge's own, by index; none when there are none. */
function ownByIndex(words: readonly (CardWords | null)[]): Record<number, CardText> | undefined {
  const found = words.flatMap((entry, index) => entry !== null && typeof entry === "object" ? [[index, entry] as const] : []);
  return found.length > 0 ? Object.fromEntries(found) : undefined;
}

export function finishPrompt(
  agent: string,
  draft: PromptDraft,
  internal: Omit<ParsedPrompt, keyof InteractivePrompt>,
  /** fields as the id reads them, where that is not as the card shows them (a fallback card's ticking working line) */
  hashed: Partial<Pick<InteractivePrompt, "title" | "question" | "body" | "steps" | "can_step_back" | "can_step_next" | "default_custom_text">> & { call?: string } = {},
): ParsedPrompt {
  // the card in English, field for field where the draft had them: the id reads the same words as ever
  const input: Omit<InteractivePrompt, "id" | "agent"> = {
    ...draft,
    title: englishOf(draft.title),
    question: englishOf(draft.question),
    body: draft.body === null ? null : englishOf(draft.body),
    options: draft.options.map((option) => ({ ...option, label: englishOf(option.label), description: option.description === null ? null : englishOf(option.description) })),
    // a draft without steps gets none: undefined, which neither the id nor the card reads
    steps: draft.steps?.map((step) => ({ ...step, label: englishOf(step.label) })),
  };
  // and which of its words are the bridge's own, for the client to show in the user's language
  const owned: NonNullable<InteractivePrompt["own_text"]> = {};
  if (typeof draft.title === "object") owned.title = draft.title;
  if (typeof draft.question === "object") owned.question = draft.question;
  if (draft.body !== null && typeof draft.body === "object") owned.body = draft.body;
  const labels = ownByIndex(draft.options.map((option) => option.label));
  if (labels) owned.labels = labels;
  const descriptions = ownByIndex(draft.options.map((option) => option.description));
  if (descriptions) owned.descriptions = descriptions;
  const steps = ownByIndex(draft.steps?.map((step) => step.label) ?? []);
  if (steps) owned.steps = steps;
  const id = createHash("sha256")
    .update(JSON.stringify({ agent, ...input, ...hashed }))
    .digest("hex")
    .slice(0, 12);
  // Hash all approval details before applying the display cap. Cursor movement
  // is excluded, but a different command, plan or option description is stale.
  return { id, agent, ...input, body: input.body?.slice(0, 12_000) ?? null, ...(Object.keys(owned).length > 0 ? { own_text: owned } : {}), ...internal };
}

export function publicPrompt(parsed: ParsedPrompt): InteractivePrompt {
  const prompt: InteractivePrompt = {
    id: parsed.id,
    agent: parsed.agent,
    kind: parsed.kind,
    title: parsed.title,
    question: parsed.question,
    body: parsed.body,
    options: parsed.options,
    multi_select: parsed.multi_select,
    ...(parsed.text_format ? { text_format: parsed.text_format } : {}),
    ...(parsed.optional ? { optional: true as const } : {}),
    ...(parsed.checks_with_text ? { checks_with_text: true as const } : {}),
    ...(parsed.drafts_saved ? { drafts_saved: true as const } : {}),
    custom_option_index: parsed.custom_option_index,
    ...(parsed.queued ? { queued: parsed.queued } : {}),
    ...(parsed.steps ? { steps: parsed.steps } : {}),
    ...(parsed.answers ? { answers: parsed.answers } : {}),
    ...(parsed.can_step_back ? { can_step_back: parsed.can_step_back } : {}),
    ...(parsed.can_step_next ? { can_step_next: parsed.can_step_next } : {}),
    ...(parsed.default_option_index !== undefined && parsed.default_option_index !== null ? { default_option_index: parsed.default_option_index } : {}),
    ...(parsed.default_option_indices ? { default_option_indices: parsed.default_option_indices } : {}),
    ...(parsed.default_custom_text ? { default_custom_text: parsed.default_custom_text } : {}),
    ...(parsed.fallback ? { fallback: true as const } : {}),
    ...(parsed.own_text ? { own_text: parsed.own_text } : {}),
    ...(parsed.screen_words ? { screen_words: parsed.screen_words } : {}),
  };
  parsedByPublicPrompt.set(prompt, parsed);
  return prompt;
}

/**
 * The questions of the form omo waits on, as its ask_user_question call asked them: the card's
 * text comes from here when the pane's session shows the call, never cut or wrapped by the pane.
 */
export interface OmoAsk {
  /** Session-qualified tool-call identity; absent only for screen-only legacy parsing. */
  id?: string;
  questions: { header: string; question: string; multiSelect: boolean; options: { label: string; description: string | null }[] }[];
  /** false: the call does not wait for its answer, and OmO folds it into a widget over its input box */
  wait?: boolean;
}

/**
 * Lines a narrow pane wrapped, joined back into one text (`lead` cut off the first line's
 * start, a row's number). A wrap at a space dropped it, so the lines join with one; but Korean,
 * Japanese and Chinese also wrap inside a word: a line that ends in a wide character, filled to
 * the pane's edge (`width`, its widest line) so that the next line's first character (wide, or
 * closing punctuation) would not have fitted after it, goes on without a space. A line filled
 * that far can also have ended at a space; the word wrapped inside is the likelier reading. The
 * session's own text, when there is one, makes this a fallback.
 */
export function joinWrapped(raw: string[], width: number, lead?: RegExp): string {
  let text = "";
  let previous = "";
  for (const line of raw) {
    const clean = text === "" && lead ? cleanLine(line).replace(lead, "") : cleanLine(line);
    if (!clean) continue;
    const first = [...clean][0]!;
    const glued = text !== "" && Bun.stringWidth([...previous.trimEnd()].at(-1) ?? "") === 2
      && (Bun.stringWidth(first) === 2 || /^[.,!?;:)\]}…]/.test(first))
      && Bun.stringWidth(previous.trimEnd()) + Bun.stringWidth(first) > width - 1;
    text += text === "" || glued ? clean : ` ${clean}`;
    previous = line;
  }
  return normalizeText(text);
}

/** The pane's width as the screen shows it: OmO's rules and its footer span all of it. */
export function screenWidth(lines: string[]): number {
  return Math.max(0, ...lines.map((line) => Bun.stringWidth(line.trimEnd())));
}

interface ListRow {
  number: number; cursor: boolean;
  /** `↑` or `↓` in the cursor's column: the window's first or last row, with more of the list beyond it */
  edge: string | null;
  /** the row after its number, as drawn */
  text: string;
  /** the first gap of two spaces or more in it: where it begins and ends in `text`, and the
   * terminal column the text after it is drawn at; -1 with no gap */
  gap: number; resumes: number; column: number;
  /** the lines wrapped under the row at that column */
  wrapped: string[];
}

/** A row of a numbered list: the cursor or a scroll mark, the row's number, then its text. */
function listRow(line: string, shape: RegExp): ListRow | null {
  const match = shape.exec(line);
  if (!match) return null;
  const text = match[3]!;
  const gap = /\s{2,}/.exec(text);
  return {
    number: Number.parseInt(match[2]!, 10), cursor: SELECTED_RE.test(match[1] ?? ""), edge: match[1] === "↑" || match[1] === "↓" ? match[1] : null,
    text, gap: gap?.index ?? -1, resumes: gap ? gap.index + gap[0].length : -1,
    // in the terminal's columns, as the lines wrapped under it are indented: a wide glyph in the name takes two
    column: gap ? Bun.stringWidth(line.slice(0, line.length - text.length + gap.index + gap[0].length)) : -1,
    wrapped: [],
  };
}

/**
 * Each row's name and what the row says of it. What the rows say stands in one column for the
 * whole list, so a gap at another column, or in one row alone, is part of that row's name
 * (`Custom  Model`). Wrapped lines are joined with a space, as most of them broke at one. A word
 * longer than its column is cut where the column ends (`longest-runni` / `ng tasks`) and stays
 * cut, as the pane shows it: a line that fills its column says nothing of whether a space was
 * there. Null: lines wrapped under a row whose gap was no column, so the rows are not as drawn.
 */
export function listNames(rows: ListRow[]): { name: string; said: string | null }[] | null {
  const counts = new Map<number, number>();
  for (const row of rows) if (row.column >= 0) counts.set(row.column, (counts.get(row.column) ?? 0) + 1);
  const [column, count] = [...counts].sort((left, right) => right[1] - left[1])[0] ?? [-1, 0];
  const shared = count >= 2 ? column : -1;
  if (rows.some((row) => row.column !== shared && row.wrapped.length > 0)) return null;
  return rows.map((row) => shared >= 0 && row.column === shared
    ? { name: row.text.slice(0, row.gap), said: [row.text.slice(row.resumes), ...row.wrapped].join(" ") }
    : { name: normalizeText(row.text), said: null });
}

/**
 * The numbered rows right above a list's hint, read downward. A row that does not count on from
 * the one above it, that follows anything but its own wrapped text, or that carries the window's
 * `↑` starts the list again, and so does any row under the one that carries its `↓`: numbered
 * lines further up (an answer's own list) are nothing of this menu's.
 * `below`: the rows a line under them counts (`more`). `first` and `last`: the first row's line
 * and the last line that was the list's.
 * `unread`: a line under a row that is not its wrapped text (a name the pane cut in two), so the
 * rows are not the list as it was drawn.
 */
export function listRows(lines: string[], hintIndex: number, shape: RegExp, more: RegExp | null): { rows: ListRow[]; below: number; first: number; last: number; unread: boolean } {
  let rows: ListRow[] = [];
  let below = 0;
  let ended = false;
  let unread = false;
  let first = -1;
  let last = -1;
  for (let index = Math.max(0, hintIndex - 80); index < hintIndex; index += 1) {
    const line = lines[index]!;
    const text = line.trim();
    const above = ended ? undefined : rows.at(-1);
    // what a row says, wrapped under itself: told by its column, before anything it happens to begin with
    if (above !== undefined && text !== "" && above.column >= 0 && line.length - line.trimStart().length === above.column) {
      above.wrapped.push(text);
      last = index;
      continue;
    }
    const row = listRow(line, shape);
    if (row) {
      if (above === undefined || row.number !== above.number + 1 || row.edge === "↑" || above.edge === "↓") [rows, first] = [[], index];
      rows.push(row);
      [below, ended, unread, last] = [0, false, false, index];
      continue;
    }
    if (above === undefined || text === "") { ended = true; continue; }
    const counted = more?.exec(text);
    if (counted) [below, ended, last] = [Number(counted[1]), true, index];
    else [ended, unread] = [true, true];
  }
  return { rows, below, first, last, unread };
}

/** a menu row: pi's cursor, an optional tick marking the current choice, then the label */
export const PI_ROW_RE = /^([\u2192\u276f\u279c])?\s*(?:[\u2713\u2714]\s+)?(\S.*)$/;

/**
 * `/model` draws a widget of its own, not the one above: `Enter to select · Ctrl+S to set as
 * default · Escape/Ctrl+C to cancel`. It carries no `↑↓ navigate`, so the menu reader cannot
 * see it, and its list is the provider catalogue — every model pi can answer with, each with
 * the provider that serves it. The cursor starts on the model in use, which is not the first
 * row once another one is current, so the position is read rather than assumed.
 */
export const PI_MODEL_HINT_RE = /enter to select\s*·\s*ctrl\+s to set as default\s*·\s*escape\/ctrl\+c to cancel/i;

/**
 * A composer or a shell's prompt: one starting with its mark (`❯`, `$ `, oh-my-zsh's `➜`), or ending
 * with it (`user@host:~/app$`). Never an ending `%`: a usage status ends with one (`usage 12%`), so
 * zsh's `host%` prompt, the rarer case, is not recognised.
 */
export const PROMPT_LINE_RE = /^(?:[❯›>➜]|[$#](?:\s|$))|[❯›>$#]$/u;

/** pi ticks the model answering now, and marks the one it starts on with `· default` */
const PI_MODEL_CURRENT_RE = /[\u2713\u2714]/;

/** a catalogue row names the provider serving the model, in brackets */
const PI_MODEL_PROVIDER_RE = /\[[^\]]+\]/;

/** the tail of a model's name a narrow pane wrapped onto its own line: only the provider's bracket */
export const PI_MODEL_TAIL_RE = /^\[[^\]]+\](\s*\u00b7\s*default)?(\s*[\u2713\u2714])?$/;

/**
 * The catalogue `/model` lists under its filter line: every row names its provider in brackets,
 * which is what tells it from pi's own notes, since `Model Name: qwen-3-8` sits indented among
 * the rows and `Could not refresh llama.cpp; showing cached models.` under them. The run ends at
 * the first line that is not a row. In a pane narrower than a model's name the row wraps: the
 * wrap is joined back first, and a row that still ends without its provider voids the reading,
 * because offering half a name would switch pi to a model that does not exist.
 */
export function piModelRows(lines: string[], startIndex: number, minRows = 2): { label: string; cursor: boolean; current: boolean }[] | null {
  const rows: { label: string; cursor: boolean; current: boolean }[] = [];
  // pi leaves a blank between its filter line and what still matches it
  let start = startIndex;
  while (start < lines.length && !cleanLine(lines[start]!)) start += 1;
  // A phone leaves pi a pane barely wider than a model's name, which wraps it and drops the
  // provider's bracket — the one mark that tells a row from a note — onto the next line at column
  // zero, where it reads exactly like a note. Join such a tail back onto the line it wrapped from
  // before reading any row, so the row keeps the name pi would answer with and the bracket that
  // proves it, and the rules below see the same rows a wide pane shows. A blank between the two
  // rules the tail out: pi separates what it means as its own line with a blank.
  const block: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index]!.replace(ANSI_RE, "");
    const line = cleanLine(raw);
    const previous = block.at(-1);
    if (previous !== undefined && cleanLine(previous) && !PI_MODEL_PROVIDER_RE.test(cleanLine(previous))
      && /^ {0,1}\S/.test(raw) && PI_MODEL_TAIL_RE.test(line)) {
      block[block.length - 1] = `${previous} ${line}`;
      continue;
    }
    block.push(raw);
  }
  // A row cut before its provider bracket closes is a catalogue still being drawn, not a note.
  // pi's own notes ("Model Name: …", "Refreshing model catalogs…") are indented lines with no
  // bracket at all, and they end the list without voiding it; an unclosed `[` is the one mark that
  // tells the two apart, and it means the rows above are a prefix of a list pi has not finished
  // writing. Offering that prefix would let a reader count down into rows that do not exist.
  const cutMidBracket = (line: string) => line.includes("[") && !PI_MODEL_PROVIDER_RE.test(line);
  for (const raw of block) {
    const line = cleanLine(raw);
    if (!line || isDivider(line) || PI_MODEL_HINT_RE.test(line)) break;
    const cursor = /^[\u2192\u276f\u279c]\s*\S/.test(line);
    if (!cursor && !/^ {2,}/.test(raw)) break;
    const label = line.match(PI_ROW_RE)?.[2]?.trim();
    if (!label || !PI_MODEL_PROVIDER_RE.test(label) || /\s{2,}/.test(label)) {
      if (cutMidBracket(line)) return null;
      break;
    }
    rows.push({ label, cursor, current: PI_MODEL_CURRENT_RE.test(raw) });
  }
  // A name wrapped in the middle of its bracket is not a model pi can be switched to, and joining
  // what is left would invent one, so any row still missing its provider voids the whole reading.
  if (!rows.every((row) => PI_MODEL_PROVIDER_RE.test(row.label))) return null;
  return rows.length >= minRows && rows.some((row) => row.cursor) ? rows : null;
}

export function navigationKeys(delta: number): string[] {
  return Array.from({ length: Math.abs(delta) }, () => delta > 0 ? KEY.down : KEY.up);
}

/** a slider's moves: → is the next level, as ↓ is the next row */
export function sliderKeys(delta: number): string[] {
  return Array.from({ length: Math.abs(delta) }, () => delta > 0 ? KEY.right : KEY.left);
}

export function keySteps(keys: string[]): AnswerStep[] {
  return keys.map((key) => ({ keys: [key] }));
}

interface OpenCodeFormDraft {
  formId: string;
  stepIndex: number;
  answers: Record<string, string | string[]>;
  updatedAt: number;
}

export interface OpenCodePromptEntry {
  sessionID: string;
  form: string | null;
  listed: OpenCodeFormInfo | null;
  available: boolean;
  draft?: OpenCodeFormDraft;
  revision: number;
  issued: number;
  applied: number;
  updatedAt: number;
}
