/**
 * A pane's last words for a list row (GET /api/pane/summary): the newest turn that said something,
 * cut short, with when it was said and when the user last asked. Read from the conversation the chat
 * lens shows, so the row and the thread never disagree.
 */
import type { ConversationPart, ConversationTurn } from "./protocol.ts";

/** Panes one summary request may name. */
export const PANE_SUMMARY_MAX_IDS = 24;
export const PANE_SUMMARY_TEXT_MAX = 280;
export const PANE_SUMMARY_DEADLINE_MS = 1500;
export const PANE_SUMMARY_PANE_MS = 400;
export const PANE_SUMMARY_KEEP_MS = 5_000;

export interface PaneSummary {
  role: "assistant" | "user";
  /**
   * one line, never empty: fence lines and block marks dropped, an inline link as its label, whitespace collapsed;
   * at most PANE_SUMMARY_TEXT_MAX UTF-16 units, cut between graphemes where the runtime has Intl.Segmenter (an emoji
   * sequence or a letter with its combining marks is kept whole or left out), else between code points (never half a
   * surrogate pair)
   */
  text: string;
  /** the turn's `end_ts ?? ts` */
  at: string | null;
  /** the `ts` of the newest turn the user wrote (not one the runtime put in their seat); null when there is none */
  asked_at: string | null;
  /** the words are a request the agent recorded as failed */
  failed?: true;
}

export interface PaneSummaries {
  /** the server's clock when it answered, so a client can tell its own offset */
  server_time: string;
  /**
   * by pane id; null for a pane with nothing said or no conversation to read (the chat's scrollback fallback), a final
   * answer for its state; a pane left out was not read this time (no time left for it, or its read failed for now) and
   * may be asked again
   */
  summaries: Record<string, PaneSummary | null>;
}

type TextPart = Extract<ConversationPart, { kind: "text" }>;

interface Words { part: TextPart; text: string }

const FENCE = /^\s*(?:`{3,}[^`]*|~{3,}.*)$/u;
/**
 * an inline link or image, `[label](target)`, read as its label: a label of at most 200 characters, a target of at
 * most 2000 that names a path, a file or an address (it holds `/`, `.`, `#` or `:`), so a call such as
 * `handlers[0](event)` stays as written; the bounds keep each `[` from scanning to the line's end
 */
const LINK = /!?\[([^\]\n]{0,200})\]\(([^()\s]{1,2000})(?:\s+"[^"\n]{0,200}")?\)/gu;
const LINK_TARGET = /[/.#:]/u;
const BLOCK_MARK = /^\s*(?:#{1,6} |[-*+] |\d+[.)] |> )/u;

function plain(text: string): string {
  const words: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    if (length > PANE_SUMMARY_TEXT_MAX) break;
    if (FENCE.test(line)) continue;
    const shown = line.replace(BLOCK_MARK, "").replace(LINK, (link, label: string, target: string) => LINK_TARGET.test(target) ? label : link)
      .replace(/\s+/gu, " ").trim();
    if (shown === "") continue;
    words.push(shown);
    length += shown.length + 1;
  }
  return words.join(" ");
}

/** Made on first use, where the runtime has one: a browser this module is bundled for may not (Safari 14, Firefox before 125). */
let graphemes: Intl.Segmenter | undefined;

function characters(text: string): Iterable<string> {
  if (typeof Intl.Segmenter === "function") graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemes ? Array.from(graphemes.segment(text), ({ segment }) => segment) : text;
}

function cut(text: string): string {
  if (text.length <= PANE_SUMMARY_TEXT_MAX) return text;
  let end = 0;
  for (const character of characters(text)) {
    if (end + character.length > PANE_SUMMARY_TEXT_MAX) break;
    end += character.length;
  }
  return text.slice(0, end);
}

function wordsOf(turn: ConversationTurn): Words | undefined {
  const texts = turn.parts.flatMap((part): Words[] => {
    if (part.kind !== "text") return [];
    const text = plain(part.text);
    return text === "" ? [] : [{ part, text }];
  });
  if (turn.role === "user") return texts[0];
  for (let index = texts.length - 1; index >= 0; index--) if (texts[index]!.part.phase === "final_answer") return texts[index];
  return texts[texts.length - 1];
}

const RUNTIME_PARTS = new Set<ConversationPart["kind"]>(["compact", "notice", "task_result", "goal_wait"]);
const userWrote = (turn: ConversationTurn): boolean => turn.role === "user" && !turn.parts.some((part) => RUNTIME_PARTS.has(part.kind));

export function summaryOf(turns: readonly ConversationTurn[]): PaneSummary | null {
  let newestUser = turns.length - 1;
  while (newestUser >= 0 && !userWrote(turns[newestUser]!)) newestUser--;
  const asked = newestUser >= 0 ? turns[newestUser]!.ts : null;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const words = wordsOf(turn);
    if (words === undefined) continue;
    return {
      role: turn.role, text: cut(words.text), at: turn.end_ts ?? turn.ts, asked_at: asked,
      ...(words.part.failed ? { failed: true as const } : {}),
    };
  }
  return null;
}
