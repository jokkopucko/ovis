/**
 * A Codex question card answered as data: where the Codex server Ovis started in the pane (approvals/codex.ts) waits on
 * the very question the card shows, the card is bound to that request (its id covers the request's), and a pick of
 * one of its options goes back by the request's id, with no key. Codex takes an option's label as its answer, as its
 * TUI sends it (`{"answers":{"<id>":{"answers":["Red"]}}}`, 0.171.0).
 *
 * A question card takes no key either where the server says the question is answered: its request answered, by Ovis
 * or from the terminal, also lately before a lost connection, or no question of the pane's thread waiting at all. Its
 * TUI may not have drawn the next screen yet. Whatever the card cannot say whole stays the TUI's, as keys while the
 * server still waits: several questions in one request (Codex's tabs), secret input, "None of the above" and its notes.
 */
import { createHash } from "node:crypto";
import type { PromptAnswer } from "../shared/protocol.ts";
import { answerServedQuestion, servedAnswered, servedQuestions, servedWaitsOnNone } from "./approvals/codex.ts";
import type { CodexAsk } from "./approvals/codex-status.ts";
import type { ParsedPrompt } from "./dialogs/shared.ts";

/** Whether `ask` is the one question `card` shows whole: not secret, the same words, the same options in the same order. */
function shows(card: ParsedPrompt, ask: CodexAsk): boolean {
  const [question, ...more] = ask.questions;
  return question !== undefined && more.length === 0 && !question.isSecret && question.question === card.question && question.options !== null
    && JSON.stringify(question.options.map((option) => option.label)) === JSON.stringify(card.options.map((option) => option.label));
}

const isQuestion = (card: ParsedPrompt): boolean => card.responder === "codex-question";

/**
 * `card` bound to the question the pane's Codex server waits on that it shows, where exactly one does: its id then
 * covers the request's, so an answer read for one request never goes to another asked alike. Any other card as it is.
 */
export function withServedAsk(paneId: string, card: ParsedPrompt): ParsedPrompt {
  if (!isQuestion(card) || card.nativeSteps !== undefined) return card;
  const waiting = servedQuestions(paneId).filter((ask) => shows(card, ask));
  if (waiting.length !== 1) return card;
  const [ask] = waiting as [CodexAsk];
  const id = createHash("sha256").update(JSON.stringify({ card: card.id, thread: ask.threadId, request: ask.key })).digest("hex").slice(0, 12);
  return { ...card, id, servedAsk: ask.key };
}

/** Whether the pane's Codex server says the question `card` shows takes no answer any more: no key may answer it. */
export function questionClosed(paneId: string, card: ParsedPrompt): boolean {
  if (!isQuestion(card)) return false;
  if (card.servedAsk !== undefined) return !servedQuestions(paneId).some((ask) => ask.key === card.servedAsk);
  return servedWaitsOnNone(paneId) || (card.nativeSteps === undefined && servedAnswered(paneId).some((ask) => shows(card, ask)));
}

/** What Codex takes for `body` on `ask`'s question: one of its options picked, and nothing else; null for any other answer. */
export function servedAnswers(ask: CodexAsk, body: PromptAnswer): Record<string, { answers: string[] }> | null {
  const [question] = ask.questions;
  const option = Number.isInteger(body.option_index) ? question?.options?.[body.option_index!] : undefined;
  if (question === undefined || option === undefined || body.option_indices !== undefined || body.custom_text !== undefined
    || body.step_back !== undefined || body.step_next !== undefined || body.step_index !== undefined || body.draft !== undefined) return null;
  return { [question.id]: { answers: [option.label] } };
}

/**
 * Answers `body` on `card` as data where the card is bound to a question its pane's Codex server waits on: "sent" once
 * the answer went, "gone" where the question takes no answer any more (no key may answer it), and null where the
 * answer is the TUI's to take as keys.
 */
export function answerServed(paneId: string, card: ParsedPrompt, body: PromptAnswer): "sent" | "gone" | null {
  if (questionClosed(paneId, card)) return "gone";
  const ask = card.servedAsk === undefined ? undefined : servedQuestions(paneId).find((waiting) => waiting.key === card.servedAsk);
  const answers = ask === undefined ? null : servedAnswers(ask, body);
  if (answers === null) return null;
  return answerServedQuestion(paneId, ask!.key, answers) ? "sent" : "gone";
}
