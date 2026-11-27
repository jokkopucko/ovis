/**
 * An OmO question that does not wait for its answer (`waitForAnswer: false`: the widget over OmO's input box,
 * dialogs/omo.ts parseOmoPending) answered as data, on the control socket of the pane's own OmO process
 * (omo-control.ts), with no key: `extension_ui_response` names the question by its call's id and files the answer under
 * the key OmO gave the question. OmO settles it as it settles one answered in its terminal, and tells the model
 * `[Answer to question <id>]` the same way (measured on OmO 5.1.81, senpi 2026.11.19-5).
 *
 * Only a call that asks this one question goes this way: OmO settles a call with the first answer it takes, so the
 * other questions of a call would go unanswered. A question that waits (OmO's form) is not on the socket (OmO answers
 * `unknown_request`); it stays keys. So does anything else the card cannot tell for certain: the socket must hold the
 * session the call was read from, and OmO must take the answer. Then the answer route types it as before.
 */
import type { PromptAnswer } from "../shared/protocol.ts";
import type { ParsedPrompt } from "./dialogs/shared.ts";
import { omoControlCall } from "./omo-control.ts";

type Answer = { selected: string[]; text?: string };

/** What OmO takes for `body` on a question whose options are `labels`; null for an answer it cannot carry. */
export function omoAnswerOf(labels: readonly string[], multiSelect: boolean, body: PromptAnswer): Answer | null {
  if (body.step_back !== undefined || body.step_next !== undefined || body.step_index !== undefined || body.draft !== undefined) return null;
  if (multiSelect ? body.option_index !== undefined : body.option_indices !== undefined) return null;
  // one choice or the user's own words, as OmO's single-choice row takes them: not both
  if (!multiSelect && body.option_index !== undefined && body.custom_text !== undefined) return null;
  const picked = multiSelect ? body.option_indices : body.option_index === undefined ? undefined : [body.option_index];
  const selected: string[] = [];
  for (const index of picked ?? []) {
    const label = Number.isInteger(index) ? labels[index] : undefined;
    if (label === undefined) return null;
    selected.push(label);
  }
  const text = body.custom_text?.trim();
  if (selected.length === 0 && !text) return null;
  return text ? { selected, text } : { selected };
}

/**
 * What OmO refuses before it applies anything (senpi session-control-commands.js answerQuestion): the answer is then the
 * terminal's to take. `unknown_request` is not one of them: OmO waits on no such question (answered meanwhile, also by
 * this same answer sent before an acknowledgment that was lost), so no key may answer it either.
 */
const REFUSED_UNAPPLIED = new Set(["question_incomplete", "invalid_response", "invalid_secret_response", "invalid_answer_id", "unsupported"]);

/**
 * Calls whose answer went with no clear word back: no key may answer them while that answer may stand, also from a
 * later request that finds no socket. The newest UNCONFIRMED_MAX are kept.
 */
const unconfirmed = new Set<string>();
const UNCONFIRMED_MAX = 64;

function unconfirmedAnswer(call: string): "gone" {
  unconfirmed.delete(call);
  unconfirmed.add(call);
  if (unconfirmed.size > UNCONFIRMED_MAX) unconfirmed.delete(unconfirmed.values().next().value!);
  return "gone";
}

/**
 * Answers `body` on `card` through `socket` before `deadlineAt`: "sent" once OmO took it, "gone" where no key may
 * answer it any more (OmO waits on no such question, or an answer may have reached OmO with no clear word back), null
 * where the answer is the terminal's to take as keys.
 */
export async function answerOmoPending(socket: string | null, card: ParsedPrompt, body: PromptAnswer, mayWrite: () => boolean, deadlineAt: number): Promise<"sent" | "gone" | null> {
  const data = card.omoData;
  const call = card.omoQuestion?.call;
  if (card.responder !== "omo-pending" || data === undefined || call === undefined) return null;
  if (socket === null) return unconfirmed.has(call) ? "gone" : null;
  const answer = omoAnswerOf(data.labels, card.multi_select, body);
  const split = call.lastIndexOf("\0");
  if (answer === null || split < 0) return null;
  const session = call.slice(0, split);
  const request = call.slice(split + 1);
  const state = await omoControlCall(socket, { type: "get_state" }, () => true, deadlineAt - Date.now());
  const sessionFile = typeof state === "object" && state["success"] === true ? (state["data"] as { sessionFile?: unknown } | undefined)?.sessionFile : undefined;
  if (sessionFile !== session) return unconfirmed.has(call) ? "gone" : null;
  const sent = await omoControlCall(socket, { type: "extension_ui_response", uiRequestId: request, answers: { [data.key]: answer } },
    () => mayWrite() && Date.now() < deadlineAt, deadlineAt - Date.now());
  if (sent === "unsent") return unconfirmed.has(call) ? "gone" : null;
  if (sent === "unknown") return unconfirmedAnswer(call);
  if (sent["success"] === true) {
    unconfirmed.delete(call);
    return "sent";
  }
  if (sent["success"] === false && REFUSED_UNAPPLIED.has(String(sent["error"]))) return unconfirmed.has(call) ? "gone" : null;
  // OmO waits on no such question (unknown_request), or its word is unclear: no later request types a key for it either
  return unconfirmedAnswer(call);
}
