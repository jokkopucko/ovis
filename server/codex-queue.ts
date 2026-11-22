import type { QueuedQuestion } from "./codex.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { ANSI_RE, cleanLine, findLastIndex, finishPrompt, normalizeText, own, publicPrompt, type ParsedPrompt } from "./dialogs/shared.ts";
import { CODEX_ASYNC_ASK_HINT_RE, CODEX_QUEUE_HEADER_RE } from "./dialogs/codex.ts";
import { sameText } from "./dialogs/omo.ts";

const CODEX_QUEUE_COUNT_RE = /^\?\s*(\d+)\s+questions?\b/;

/**
 * In Codex, a message of the user's own waiting to be submitted replaces the questions' block
 * (alt+↑ then opens nothing, checked on Codex 0.156.1), and an open question (its "enter submit …
 * skip" hint) or an approval under the queue holds the input itself.
 */
export function queuedQuestionCount(screen: string): number {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  const header = findLastIndex(lines, (line) => CODEX_QUEUE_HEADER_RE.test(line));
  // the queue sits right above the main prompt and its status line
  if (header < 0 || lines.length - header > 16) return 0;
  if (lines.slice(header).some((line) => /^↳\s/.test(line) || /Messages to be submitted/i.test(line) || CODEX_ASYNC_ASK_HINT_RE.test(line))) return 0;
  const at = lines.findIndex((line, index) => index > header && index <= header + 7 && CODEX_QUEUE_COUNT_RE.test(line));
  // (the main prompt, not a numbered menu row the parser did not recognise; Codex 0.164 draws
  // the main prompt as » at Ultra reasoning effort, numbered menu rows keep ›)
  if (at < 0 || !/\bto answer$/i.test(lines[at + 1] ?? "") || !/^[›»]\s(?!\d+\.)/.test(lines[at + 2] ?? "")) return 0;
  return Number(lines[at]!.match(CODEX_QUEUE_COUNT_RE)![1]);
}

export interface QueueFront { question: string; options: string[] }

/**
 * The collapsed queue shows only a count: the card takes its first question from the
 * rollout, the newest `count` unanswered ones (a skipped question leaves no record).
 */
function queuedPrompt(count: number, unanswered: QueuedQuestion[], front: QueueFront | null = null): ParsedPrompt | null {
  const waiting = unanswered.slice(-count);
  const first = (front !== null ? [...unanswered].reverse().find((question) => sameText(front.question, question.title)
    && question.options.length === front.options.length && question.options.every((option, index) => sameText(front.options[index]!, option))) : undefined)
    ?? waiting[0];
  if (!first || waiting.length !== count || !first.title.trim()) return null;
  return finishPrompt("codex", {
    kind: "question", title: count > 1 ? own("Question {n} of {total}", { n: 1, total: count }) : own("Question"), question: normalizeText(first.title), body: null,
    options: first.options.map((label) => ({ label, description: null })),
    multi_select: false, custom_option_index: first.options.length, queued: "collapsed",
  }, {
    responder: "codex-queued-question", menuLabels: first.options.length ? [...first.options, "Other"] : [],
    selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: first.options.length, rejectWithEscapeIndex: null,
  });
}

export function codexQueuedPrompt(screen: string, unanswered: QueuedQuestion[], front: QueueFront | null = null): InteractivePrompt | null {
  const count = queuedQuestionCount(screen);
  const queued = count > 0 ? queuedPrompt(count, unanswered, front) : null;
  return queued ? publicPrompt(queued) : null;
}
