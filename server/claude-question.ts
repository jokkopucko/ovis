/**
 * A Claude question card answered as data: where the PermissionRequest hook of a Claude Ovis started holds the one
 * question the card shows (approvals/claude.ts), and no other request asked in the same words, the card is bound to
 * that request (prompt.ts withHeldPermission), and its answer goes back as that request's input with no key: an
 * option's label, or the words typed where the card offers a row for them, as Claude Code 2.1.330 takes them. Every
 * other answer stays the dialog's, as keys.
 */
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import type { HeldQuestion } from "./approvals/hub.ts";

/** Whether `card` shows `question` whole: one pick, of its options in the same order. */
export function showsHeldQuestion(card: InteractivePrompt, question: HeldQuestion): boolean {
  return !card.multi_select && JSON.stringify(card.options.map((option) => option.label)) === JSON.stringify(question.options);
}

/** What Claude takes for `body` on `card`'s question, or null for an answer that goes as keys. */
export function heldQuestionAnswer(card: InteractivePrompt, body: PromptAnswer): string | null {
  if (body.step_back !== undefined || body.step_next !== undefined || body.step_index !== undefined || body.draft !== undefined
    || body.option_indices !== undefined || (body.option_index === undefined) === (body.custom_text === undefined)) return null;
  if (body.option_index !== undefined) return Number.isInteger(body.option_index) ? card.options[body.option_index]?.label ?? null : null;
  const typed = card.custom_option_index !== null && card.custom_option_index !== undefined;
  return typed && typeof body.custom_text === "string" && body.custom_text.trim() !== "" ? body.custom_text : null;
}
