import type { CardText, ConversationTurn, InteractivePrompt, InteractivePromptOption } from "../../shared/protocol.ts";
import { askedQuestions } from "../../shared/askQuestions.ts";
import { parseInline, shownText } from "../../shared/markdown.ts";
import { t as inCurrentLanguage, type Translate } from "./i18n.ts";

/**
 * An option's name as its card shows it, the one reading the card's rendering and a typed answer share
 * (#2220): an omp or gjc card in Markdown shows its label whole (InlineMarkdown) without stripping
 * literal `(Recommended)` text — only options explicitly carrying `recommended: true` show the
 * Recommended tag. Plain-text cards read a leading or trailing "(Recommended)" off as that tag
 * (Claude draws its own pick as "Redis (Recommended)").
 */
export function optionName(prompt: InteractivePrompt, option: string | InteractivePromptOption): { text: string; recommended: boolean; words: string } {
  const label = typeof option === "string" ? option : option.label;
  const marked = typeof option !== "string" && option.recommended === true;
  if (prompt.text_format === "markdown") {
    return { text: label, recommended: marked, words: shownText(parseInline(label, false)) ?? label };
  }
  const text = label.replace(/^\(recommended\)\s+|\s*\(recommended\)$/i, "");
  return { text, recommended: marked || text !== label, words: text };
}

/** What an approval's option grants: this one call, every call like it from now on, or nothing. */
export type ApprovalScope = "once" | "always" | "deny";

const TRAILING_HINT = /\s*[([][^)\]]*[)\]]\s*$/u;

/**
 * The scope an approval option's own words state, or `yes` for a bare consent whose scope they
 * leave unsaid: "No…", "Deny", "Reject" and pi's "Block" deny; a consent that says "don't ask
 * again", "always", "allow all" or "this session" keeps allowing; one that says "once" or "this
 * time" allows this once. Any other wording ("Modify with external editor") states no scope.
 */
function statedScope(label: string): ApprovalScope | "yes" | null {
  const words = label.replace(TRAILING_HINT, "").trim().toLowerCase();
  if (/^(?:(?:no|deny|reject|block)\b|always\s+(?:deny|reject|block)\b)/u.test(words)) return "deny";
  if (!/^(?:yes|allow|approve|always)\b/u.test(words)) return null;
  if (/\balways\b|\b(?:don'?t|do not|never) ask(?: me)? again\b|\ballow all\b|\b(?:for|during) (?:the rest of )?this (?:session|project)\b|\bfrom now on\b/u.test(words)) return "always";
  if (/\band\s+enable\b/u.test(words)) return null;
  if (/\bonce\b|\bone time\b|\bthis time\b|\bjust this\b/u.test(words)) return "once";
  return /^(?:yes|allow|approve)(?:,?\s+(?:proceed|allow|approve|run it))?$/u.test(words) ? "yes" : null;
}

/**
 * What an approval option grants, read off the agent's own words and never guessed (G-071): the
 * scope its label states, or, for a bare "Yes" beside an option that keeps allowing (Codex's
 * "Yes, and don't ask again…", Claude's "Yes, allow all edits this session"), this once. A bare
 * "Yes" with no such neighbour, any other wording, and every other kind of card get no scope.
 */
export function approvalScope(prompt: InteractivePrompt, index: number): ApprovalScope | null {
  if (prompt.kind !== "approval") return null;
  const stated = prompt.options.map((option) => statedScope(option.label));
  const own = stated[index] ?? null;
  if (own !== "yes") return own;
  return stated.includes("always") ? "once" : null;
}

export function cardText(card: CardText, t: Translate = inCurrentLanguage): string {
  const vars = card.vars === undefined ? undefined
    : Object.fromEntries(Object.entries(card.vars).map(([name, value]) => [name, value !== null && typeof value === "object" ? cardText(value, t) : value]));
  return t(card.key, vars);
}

/**
 * Claude's words read off the screen over its question (`screen_words`, #2088), for the card to show
 * while the chat has no record of them: Claude Code 2.1.311 writes the turn to its session file only
 * with the answer.
 */
export function screenWordsToShow(prompt: InteractivePrompt, turns: readonly ConversationTurn[]): string | null {
  if (!prompt.screen_words) return null;
  const same = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
  const labels = prompt.options.map((option) => option.label);
  const headed = (header: string | null): boolean => prompt.own_text?.title !== undefined || header === null
    || same(prompt.title, header) || prompt.title.startsWith(`${header.trim()} · `);
  const asksThis = (input: string): boolean => {
    let args: unknown;
    try { args = JSON.parse(input); } catch { return false; }
    return askedQuestions("AskUserQuestion", args)?.some((question) => same(question.question, prompt.question) && headed(question.header)
      && question.options.length === labels.length && question.options.every((option, index) => same(option.label, labels[index]!))) ?? false;
  };
  const turn = turns.at(-1);
  const recorded = turn?.role === "assistant" && turn.parts.some((part) =>
    part.kind === "tool" && part.name === "AskUserQuestion" && part.state === "pending" && asksThis(part.input));
  return recorded ? null : prompt.screen_words;
}

export function polledPrompt(current: InteractivePrompt | null, next: InteractivePrompt | null): InteractivePrompt | null {
  if (current === null || next === null || current.id !== next.id) return next;
  const shown = (prompt: InteractivePrompt) => JSON.stringify([prompt.steps, prompt.can_step_back, prompt.own_text, prompt.question, prompt.body, prompt.options, prompt.text_format ?? null, prompt.screen_words ?? null, prompt.option_preview ?? null]);
  if (shown(current) === shown(next)) return current;
  const { text_format: _format, screen_words: _words, option_preview: _preview, ...kept } = current;
  return {
    ...kept, steps: next.steps, can_step_back: next.can_step_back, own_text: next.own_text,
    question: next.question, body: next.body, options: next.options, ...(next.text_format ? { text_format: next.text_format } : {}),
    ...(next.screen_words !== undefined ? { screen_words: next.screen_words } : {}),
    ...(next.option_preview !== undefined ? { option_preview: next.option_preview } : {}),
  };
}

export function capped(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function promptWords(prompt: InteractivePrompt, t: Translate = inCurrentLanguage) {
  const own = prompt.own_text;
  const words = (text: string, card: CardText | undefined): string => card === undefined ? text : cardText(card, t);
  return {
    title: words(prompt.title, own?.title),
    question: words(prompt.question, own?.question),
    // the bridge shows at most 12,000 characters of a body (finishPrompt): a translated one too
    body: prompt.body === null ? null : capped(words(prompt.body, own?.body), 12_000),
    label: (index: number): string => words(prompt.options[index]?.label ?? "", own?.labels?.[index]),
    description: (index: number): string | null => {
      const description = prompt.options[index]?.description ?? null;
      return description === null ? null : words(description, own?.descriptions?.[index]);
    },
    step: (index: number): string => words(prompt.steps?.[index]?.label ?? "", own?.steps?.[index]),
  };
}
