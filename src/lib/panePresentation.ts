import type { Machine } from "../../shared/machines.ts";
import type { ConversationResponse, ConversationTurn, HerdrPane } from "../../shared/protocol.ts";
import type { PaneView } from "./actions.ts";
import { turnRevision } from "./turnRevision.ts";
import { readSeenFinish } from "./seenFinishes.ts";

export const PANE_COVER_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],dialog[open],.menu.composer-menu';

type ConversationProof = { source: ConversationResponse["source"] | undefined; history_id?: string; turns: readonly ConversationTurn[] };

/** These Claude notices and an OmO goal's wait do not start another model turn. Runtime wakes and real prompts do. */
const passive = (turn: ConversationTurn | undefined): boolean => turn?.role === "user" && turn.parts.length > 0
  && turn.parts.every((part) => part.kind === "goal_wait" || part.kind === "notice" && (part.source === "informational" || part.source === "local-command"));
const compaction = (turn: ConversationTurn | undefined): boolean => turn?.role === "user" && turn.parts.length > 0 && turn.parts.every((part) => part.kind === "compact");
/** `/compact`, with or without its instructions, as Claude Code records the command typed */
const compactCommand = (turn: ConversationTurn | undefined): boolean => turn?.role === "user" && turn.parts.length === 1
  && turn.parts[0]!.kind === "text" && /^\/compact(?:\s|$)/u.test(turn.parts[0]!.text.trim());

function commanded(conversation: ConversationProof, index: number): number | null {
  let before = index - 1;
  while (before >= 0 && passive(conversation.turns[before])) before--;
  return compactCommand(conversation.turns[before]) ? before : null;
}

/**
 * Where the newest final answer is, past what starts no model turn after it: the notices above, a compaction the user
 * asked for (its `/compact` and its summary, #3675), and one Claude Code ran by itself (at rest it leaves the finish as
 * it was). Only the first proves a finish of its own (compactionsAfter).
 */
function finalAnswerIndex(conversation: ConversationProof): number {
  let index = conversation.turns.length - 1;
  while (index >= 0) {
    const turn = conversation.turns[index];
    if (passive(turn)) { index--; continue; }
    if (compaction(turn)) { index = (commanded(conversation, index) ?? index) - 1; continue; }
    break;
  }
  return index;
}

function finalAnswer(conversation: ConversationProof): ConversationTurn | undefined {
  const index = finalAnswerIndex(conversation);
  const turn = conversation.turns[index];
  const last = turn?.parts.at(-1);
  return turn?.role === "assistant" && last?.kind === "text" && last.phase === "final_answer" && last.text.trim().length > 0 ? turn : undefined;
}

export function conversationFinishPresented(conversation: ConversationProof): boolean {
  return finalAnswer(conversation) !== undefined;
}

function allCompactionsAfter(conversation: ConversationProof, turn: ConversationTurn): ConversationTurn[] {
  const from = conversation.turns.indexOf(turn) + 1;
  return conversation.turns.filter((later, index) => index >= from && compaction(later));
}

/**
 * The compactions after the newest final answer that prove a finish of their own, oldest first. Claude Code records the
 * `/compact` typed, so there one it ran by itself proves none; the other agents record none, and each of theirs proves one.
 */
function compactionsAfter(conversation: ConversationProof, turn: ConversationTurn): ConversationTurn[] {
  const all = allCompactionsAfter(conversation, turn);
  return conversation.source !== "claude-transcript" ? all : all.filter((later) => commanded(conversation, conversation.turns.indexOf(later)) !== null);
}

function answerIdentity(conversation: ConversationProof, compacted?: ConversationTurn | null): string | undefined {
  const turn = finalAnswer(conversation);
  if (!turn) return undefined;
  // A compaction after the answer (Claude Code's /compact) is a finish of its own: the proof is dated from it, so the
  // finish it brings is not refused as the answer's earlier one (#3675)
  if (compacted === undefined) compacted = compactionsAfter(conversation, turn).at(-1);
  return JSON.stringify([conversation.source, conversation.history_id, compacted?.ts ?? turn.end_ts ?? turn.ts, turnRevision({
    role: turn.role, ts: turn.ts, parts: [...turn.parts.filter((part) => part.kind === "text" && part.phase === "final_answer"),
      ...compacted?.parts.filter((part) => part.kind === "compact") ?? []],
  })]);
}

function completedProof(answer: string): { identity: string; time: number } | undefined {
  try {
    const value: unknown = JSON.parse(answer);
    if (Array.isArray(value) && typeof value[2] === "string" && typeof value[3] === "string") {
      const time = Date.parse(value[2]);
      if (Number.isFinite(time)) return { identity: JSON.stringify([value[0], value[1], value[3]]), time };
    }
  } catch {}
  return undefined;
}

export class ConversationFinishEvidence {
  private readonly latest = new Map<string, { id: number; answer: string }>();
  private readonly observed = new Map<string, number>();

  observe(scope: string, id: number): void {
    if (id <= (this.observed.get(scope) ?? 0)) return;
    this.observed.delete(scope);
    this.observed.set(scope, id);
    if (this.observed.size > 256) this.observed.delete(this.observed.keys().next().value!);
  }

  accept(scope: string, id: number, conversation: ConversationProof, before?: ConversationProof): boolean {
    if (id <= 0 || id < (this.observed.get(scope) ?? 0)) return false;
    // A later stale lower event must not bind a newer transcript to the older finish.
    this.observe(scope, id);
    const answer = answerIdentity(conversation);
    if (!answer) return false;
    const stored = readSeenFinish(scope);
    const remembered = this.latest.get(scope);
    const known = stored && stored.id > (remembered?.id ?? 0) ? stored : remembered ?? stored;
    if (known) {
      if (id < known.id) return false;
      const previous = known.answer === undefined ? undefined : completedProof(known.answer), current = completedProof(answer);
      if (id === known.id && known.answer !== undefined) {
        if (answer === known.answer) return true;
        // Codex dates the answer again when its task_complete lands later: the same answer, still this
        // finish's. Only a native start time tells that turn from an older reply with the same text.
        const started = finalAnswer(conversation)?.ts;
        return typeof started === "string" && started !== "" && previous !== undefined && previous.identity === current?.identity;
      }
      if (answer === known.answer) return false;
      // a proof that rests on a compaction proves only the finish right after the one its answer, or a compaction
      // before it, was seen at (or one seen from the terminal, which keeps no answer): the compaction's own. A later
      // finish may be another task's, whose turn is not in this transcript yet (#3675)
      const answered = answerIdentity(conversation, null);
      if (answer !== answered) {
        const turn = finalAnswer(conversation)!;
        const proving = compactionsAfter(conversation, turn).at(-1);
        // a proof by any other compaction of the answer, one Claude Code ran by itself included: an earlier version saved those
        const before = allCompactionsAfter(conversation, turn).filter((later) => later !== proving).map((later) => answerIdentity(conversation, later));
        if (id !== known.id + 1 || (known.answer !== undefined && known.answer !== answered && !before.includes(known.answer))) return false;
      }
      if (known.answer !== undefined) {
        if (!previous || !current || current.identity === previous.identity || current.time <= previous.time) return false;
      }
    }
    // The transcript ends in a final answer even when finishes were skipped or no answer
    // was saved. Bind it to this finish, not an earlier baseline that may never advance.
    // A 304 for another presentation key is not a new proof. A first independently read
    // completion establishes the baseline; subsequent IDs must advance that baseline.
    if (conversation === before) return false;
    this.latest.delete(scope);
    this.latest.set(scope, { id, answer });
    if (this.latest.size > 256) this.latest.delete(this.latest.keys().next().value!);
    return true;
  }

  answer(scope: string, id: number): string | undefined {
    const known = this.latest.get(scope);
    return known?.id === id ? known.answer : undefined;
  }
}
export const conversationFinishEvidence = new ConversationFinishEvidence();

export function paneCovered(exclude?: string, selector = PANE_COVER_SELECTOR): boolean {
  return [...document.querySelectorAll(selector)].some((node) =>
    (!exclude || !node.matches(exclude)) && !node.closest('[hidden],[inert],[aria-hidden="true"],.is-hidden')
      && node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible");
}

export function paneContentKey(machine: Machine | undefined, pane: HerdrPane | null, view: PaneView): string | undefined {
  return machine && pane ? JSON.stringify([machine.id, pane.pane_id, pane.terminal_id, view, machine.snapshot?.finish_epoch, pane.finish_id]) : undefined;
}

export function paneContentPresented(key: string | undefined): boolean {
  if (key === undefined) return false;
  return [...document.querySelectorAll("[data-pane-content]")].some((node) =>
    node.getAttribute("data-pane-content") === key && !node.querySelector("[data-pane-content-error]"));
}
