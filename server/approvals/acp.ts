/**
 * The cards of an ACP child (server/acp/children.ts): each `session/request_permission` its agent asks becomes a card
 * with the agent's own options, unchanged and in order, and the card's answer is the option the agent gets. Ovis asks
 * nothing of its own, so a child that requests nothing has no card. The card shows the oldest request nobody answered
 * yet; its id names that request (the keeper's id and a digest of the request as archived), so an answer settles that
 * request and no other.
 */
import { createHash } from "node:crypto";
import type { CardText, InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import type { AcpApproval, KeeperClient } from "../acp/client.ts";
import { englishOf, own } from "../dialogs/shared.ts";
import { shellQuote } from "../machine-security.ts";
import { showable } from "./hub.ts";

/** The ACP child running in a pane, as the prompt routes look it up. */
export interface AcpCards {
  forPane(paneId: string): { harness: string; client: KeeperClient } | undefined;
}

/** The most of a card's body the bridge and the card show (finishPrompt, promptWords). */
const CARD_BODY_MAX = 12_000;
const INCOMPLETE = own("This request cannot be shown in full. Press F4 in the terminal to read it.");
const TITLE: CardText = own("Permission request");
const QUESTION: CardText = own("Choose an option");

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

/** The agent's command, its other input, and the content it sent with the request, in that order. */
function words({ rawInput, content }: AcpApproval["toolCall"]): string[] | null {
  const input = record(rawInput);
  const command = input?.["command"];
  const shown = typeof command === "string" ? [command]
    : Array.isArray(command) && command.every((word) => typeof word === "string") ? [command.map((word) => /^[\w./:@%+=,-]+$/.test(word) ? word : shellQuote(word)).join(" ")]
    : rawInput === null || (input !== null && Object.keys(input).length === 0) ? []
    : [JSON.stringify(rawInput, null, 2)];
  if (input && (typeof command === "string" || Array.isArray(command))) {
    const { command: _, ...rest } = input;
    if (Object.keys(rest).length > 0) shown.push(JSON.stringify(rest, null, 2));
  }
  if (content !== null && !Array.isArray(content)) return null;
  for (const item of content ?? []) {
    const entry = record(item);
    const said = entry?.["type"] === "content" ? text(record(entry["content"])?.["text"])
      : entry?.["type"] === "diff" ? [text(entry["path"]), text(entry["oldText"]), text(entry["newText"])].filter((part) => part !== null).join("\n") || null
      : null;
    if (said === null) return null;
    shown.push(said);
  }
  return shown;
}

function choices(approval: AcpApproval) {
  const wordsShown = words(approval.toolCall)?.join("\n\n");
  const title = text(approval.toolCall.title);
  const hidden = (title !== null && !showable(title)) || wordsShown === undefined || wordsShown.length > CARD_BODY_MAX || !showable(wordsShown);
  const options = hidden ? approval.options.filter(({ kind }) => kind === "reject_once" || kind === "reject_always" || kind === "cancel") : approval.options;
  return { body: hidden ? englishOf(INCOMPLETE) : wordsShown || null, options, hidden };
}

const cardId = (approval: AcpApproval) => `acp.${approval.keeperId}.${createHash("sha256").update(approval.raw).digest("hex").slice(0, 16)}`;

/** A card and its answer use the same ordered subset of the agent's choices. */
export function acpCard(harness: string, approval: AcpApproval): InteractivePrompt {
  const title = text(approval.toolCall.title);
  const ownTitle = title === null || !showable(title);
  const { body, options, hidden } = choices(approval);
  return {
    id: cardId(approval),
    agent: harness,
    kind: "approval",
    title: ownTitle ? englishOf(TITLE) : title,
    question: englishOf(QUESTION),
    body,
    options: options.map((option) => ({ label: option.name, description: null })),
    multi_select: false,
    custom_option_index: null,
    own_text: { ...(hidden ? { body: INCOMPLETE } : {}), ...(ownTitle ? { title: TITLE } : {}), question: QUESTION },
  };
}

/** The card a pane's ACP child shows now: its oldest open request, or none. */
export function acpPrompt(child: { harness: string; client: KeeperClient }): InteractivePrompt | null {
  const oldest = child.client.pending()[0];
  if (oldest) return acpCard(child.harness, oldest);
  const q = child.client.questions.current;
  if (!q || q.parent) return null;
  const field = q.field;
  const title = own("Question");
  const label = own(field ? "Type your answer" : "Cancel");
  const options = field?.choices.map(({ label, description }) => ({ label, description })) ?? [];
  const custom = field?.custom ? options.length : null;
  const labels = custom !== null || !field ? { [options.length]: label } : {};
  if (custom !== null || !field) options.push({ label: englishOf(label), description: null });
  return { id: q.id, agent: child.harness, kind: "question", title: englishOf(title), question: field?.prompt ?? q.message ?? englishOf(title),
    body: null, options, custom_option_index: custom, multi_select: field?.multiple ?? false,
    ...(field?.optional ? { optional: true } : {}), ...(field?.multiple && field.custom ? { checks_with_text: true } : {}),
    own_text: { title, labels, ...(!field && !q.message ? { question: title } : {}) } };
}

/**
 * Answers the card `promptId` with its option `optionIndex`: answered once the keeper sent this answer to the agent;
 * changed when the request is no longer open or another answer went first; invalid for an option the card has not.
 */
export async function answerAcpPrompt(child: { harness: string; client: KeeperClient }, body: PromptAnswer): Promise<"answered" | "changed" | "invalid"> {
  const { prompt_id: promptId, option_index: optionIndex } = body;
  if (promptId.startsWith("question.")) {
    if (child.client.pending().length || child.client.status !== "blocked") return "changed";
    if (body.custom_text !== undefined && typeof body.custom_text !== "string") return "invalid";
    const indices = body.option_indices ?? (optionIndex === undefined || body.custom_text !== undefined && optionIndex === child.client.questions.current?.field?.choices.length ? [] : [optionIndex]);
    if (!Array.isArray(indices)) return "invalid";
    return child.client.questions.respond(promptId, null, { indices, text: body.custom_text });
  }
  const asked = child.client.pending().find((request) => cardId(request) === promptId);
  if (asked === undefined) return "changed";
  const option = typeof optionIndex === "number" && Number.isInteger(optionIndex) ? choices(asked).options[optionIndex] : undefined;
  if (option === undefined) return "invalid";
  return await child.client.answer(asked.keeperId, option.optionId) === "won" ? "answered" : "changed";
}
