import type { Machine } from "../../shared/machines.ts";
import type { ConversationResponse, ConversationTurn, HerdrPane } from "../../shared/protocol.ts";
import type { PaneView } from "./actions.ts";
import { turnRevision } from "./turnRevision.ts";
import { readSeenFinish } from "./seenFinishes.ts";

export const PANE_COVER_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],dialog[open],.menu.composer-menu';

type ConversationProof = { source: ConversationResponse["source"] | undefined; history_id?: string; turns: readonly ConversationTurn[] };

function finalAnswer(conversation: ConversationProof): ConversationTurn | undefined {
  let index = conversation.turns.length - 1;
  // These Claude notices do not start another model turn. Runtime wakes and real prompts do.
  while (index >= 0) {
    const turn = conversation.turns[index];
    if (turn?.role !== "user" || turn.parts.length === 0 || !turn.parts.every((part) =>
      part.kind === "notice" && (part.source === "informational" || part.source === "local-command"))) break;
    index--;
  }
  const turn = conversation.turns[index];
  const last = turn?.parts.at(-1);
  return turn?.role === "assistant" && last?.kind === "text" && last.phase === "final_answer" && last.text.trim().length > 0 ? turn : undefined;
}

/** No source gets an exemption: absent native completion evidence keeps the dot. */
export function conversationFinishPresented(conversation: ConversationProof): boolean {
  return finalAnswer(conversation) !== undefined;
}

function answerIdentity(conversation: ConversationProof): string | undefined {
  const turn = finalAnswer(conversation);
  if (!turn) return undefined;
  // Do not date a finish from later tool-result decoration or a trailing informational notice.
  return JSON.stringify([conversation.source, conversation.history_id, turn.end_ts ?? turn.ts, turnRevision({
    role: turn.role, ts: turn.ts, parts: turn.parts.filter((part) => part.kind === "text" && part.phase === "final_answer"),
  })]);
}

function completedProof(answer: string): { identity: string; time: number } | undefined {
  try {
    const value: unknown = JSON.parse(answer);
    if (Array.isArray(value) && typeof value[2] === "string" && typeof value[3] === "string") {
      const time = Date.parse(value[2]);
      if (Number.isFinite(time)) return { identity: JSON.stringify([value[0], value[1], value[3]]), time };
    }
  } catch { /* an older stored proof without a native time cannot establish ordering */ }
  return undefined;
}

/** Shared across retained/remounted chat renderers; scoped by PC, pane and server epoch. */
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

/** Retained phone siblings keep their suggestions, but invisible content covers no pane. */
export function paneCovered(exclude?: string, selector = PANE_COVER_SELECTOR): boolean {
  return [...document.querySelectorAll(selector)].some((node) =>
    (!exclude || !node.matches(exclude)) && !node.closest('[hidden],[inert],[aria-hidden="true"],.is-hidden')
      && node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible");
}

/** A rendered content lifetime, not merely a selected pane slot. */
export function paneContentKey(machine: Machine | undefined, pane: HerdrPane | null, view: PaneView): string | undefined {
  return machine && pane ? JSON.stringify([machine.id, pane.pane_id, pane.terminal_id, view, machine.snapshot?.finish_epoch, pane.finish_id]) : undefined;
}

/** The marker lives on the successfully rendered content and disappears with its error boundary. */
export function paneContentPresented(key: string | undefined): boolean {
  if (key === undefined) return false;
  return [...document.querySelectorAll("[data-pane-content]")].some((node) =>
    node.getAttribute("data-pane-content") === key && !node.querySelector("[data-pane-content-error]"));
}
