import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { turnSkills } from "./skillActivity.ts";
import { isTodoTool, todoSnapshot, type TodoItem } from "./todos.ts";
import { t } from "./i18n.ts";

export type ToolPart = Extract<ConversationPart, { kind: "tool" }>;
export type ThinkingPart = Extract<ConversationPart, { kind: "thinking" }>;
export type TextPart = Extract<ConversationPart, { kind: "text" }>;

/**
 * A turn the way Codex shows it: tool calls, reasoning and explicit progress narration fold under
 * one "Worked for 7s · 1 edit" header. Every other assistant response stays in the main chat,
 * including an unphased response followed by more work or another answer.
 */
export interface SplitTurn {
  work: ConversationPart[];
  answer: TextPart[];
}

const isProse = (part: ConversationPart): part is TextPart => part.kind === "text" && part.text.trim().length > 0;
const isAnswer = (part: ConversationPart): part is TextPart => isProse(part) && part.phase !== "commentary";
const isWork = (part: ConversationPart): boolean => part.kind !== "text" || (isProse(part) && part.phase === "commentary");

export function splitTurn(parts: ConversationPart[]): SplitTurn {
  return { work: parts.filter(isWork), answer: parts.filter(isAnswer) };
}

/** `start`: the index of the run's first part in the turn, which names the run while it grows */
export type TurnSegment = { kind: "work"; start: number; parts: ConversationPart[] } | { kind: "answer"; start: number; parts: TextPart[] };
export type WorkSegment = Extract<TurnSegment, { kind: "work" }>;

/**
 * The turn in the agent's own order, as its terminal shows it: each run of work between two
 * answers is its own block, so words written before a tool call stay above it. Classified as
 * `splitTurn` classifies; whitespace-only text is in neither.
 */
export function turnSegments(parts: ConversationPart[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  parts.forEach((part, index) => {
    const last = segments.at(-1);
    if (isAnswer(part)) {
      if (last?.kind === "answer") last.parts.push(part);
      else segments.push({ kind: "answer", start: index, parts: [part] });
    } else if (isWork(part)) {
      if (last?.kind === "work") last.parts.push(part);
      else segments.push({ kind: "work", start: index, parts: [part] });
    }
  });
  return segments;
}

/**
 * The name of each run's block, which also keeps its fold. A run keeps its name while its parts
 * change: words before its tools join it (a record marks them commentary, a blank one is filled
 * in), a part leaves it, or it splits or merges with another run (#2063). `previous` holds the name
 * of the run each part was in when the turn was last drawn, by part index. A run takes the first
 * of those names among its own parts that no earlier run has taken. Only then does a run with none
 * get `work:<start>`, so a new run never takes the name of a run already shown.
 *
 * A run that draws no block (`drawn`: hidden reasoning alone) has no fold to keep: the runs drawn
 * choose first, so it never takes a drawn block's name when the two split or merge (#2111). Its own
 * name is `dormant`, by part index as `previous` is: a run drawn again takes it back, its fold with
 * it, but only after every name a drawn run had.
 */
export function runNames(runs: readonly WorkSegment[], at: ReadonlyMap<ConversationPart, number>, previous: ReadonlyMap<number, string>,
  drawn: (run: WorkSegment) => boolean = () => true, dormant: ReadonlyMap<number, string> = new Map()): string[] {
  const used = new Set<string>();
  const kept: (string | undefined)[] = runs.map(() => undefined);
  const take = (index: number, from: ReadonlyMap<number, string>): void => {
    const name = runs[index]!.parts.map((part) => from.get(at.get(part)!)).find((name) => name !== undefined && !used.has(name));
    if (name !== undefined) { used.add(name); kept[index] = name; }
  };
  const shown = runs.flatMap((run, index) => drawn(run) ? [index] : []);
  const hidden = runs.flatMap((run, index) => drawn(run) ? [] : [index]);
  for (const group of [shown, hidden]) for (const from of [previous, dormant]) for (const index of group) if (kept[index] === undefined) take(index, from);
  return runs.map((run, index) => {
    if (kept[index] !== undefined) return kept[index];
    let name = `work:${run.start}`;
    while (used.has(name)) name += "+";
    used.add(name);
    return name;
  });
}

/**
 * A work block is open while its turn runs and folded once the turn settles: the answer stays
 * outside the fold, so a finished turn reads as its answer under one "Worked for" row.
 *
 * A settled turn keeps its block open when explicit commentary comes after the last answer, or
 * when commentary has no answer at all. Folding would hide the newest thing the agent said, or all
 * of it. It takes the turn's parts, not the split: the order decides.
 */
export function workStartsOpen(live: boolean, parts: ConversationPart[]): boolean {
  if (live) return true;
  const lastAnswer = splitTurn(parts).answer.at(-1);
  const after = lastAnswer === undefined ? 0 : parts.lastIndexOf(lastAnswer) + 1;
  // everything readable after the last answer part is work: it is inside the fold
  return parts.slice(after).some((part) => part.kind === "text" && part.text.trim().length > 0);
}

/**
 * Whether one block of a turn starts open, until the reader opens or closes it. `live` and `waiting`
 * are the block's own (only the turn's head runs or waits); `last`: no part of the turn comes after
 * its run. By default that is `workStartsOpen`: the running block open, a settled turn's last block
 * open for words said after its answer. With Collapse work on (Settings → Chat) every block starts
 * folded to its head line, the running one included, as the Codex and Claude apps keep one working
 * line (#2228); the block that waits on the user still opens, since it may hold what they answer.
 */
export function workBlockStartsOpen(block: { live: boolean; waiting: boolean; last: boolean }, parts: ConversationPart[], foldWork: boolean): boolean {
  if (foldWork) return block.waiting;
  return block.live || (block.last && workStartsOpen(false, parts));
}

type WorkCategory = "edit" | "read" | "command" | "other";

/** "{n} edit" / "{n} edits": both forms are translated, Korean uses one */
export const CATEGORY_LABEL: Record<WorkCategory, [singular: string, plural: string]> = {
  edit: ["{n} edit", "{n} edits"],
  read: ["{n} file read", "{n} file reads"],
  command: ["{n} command", "{n} commands"],
  other: ["{n} other tool", "{n} other tools"],
};

function categorize(name: string): WorkCategory {
  const lower = name.toLowerCase();
  if (/edit|write|patch|create_file|multiedit/.test(lower)) return "edit";
  if (/^(read|glob|grep|ls|list|search|find|cat)/.test(lower)) return "read";
  if (/bash|command|shell|exec|eval|run/.test(lower)) return "command";
  return "other";
}

/**
 * "1 edit · 2 file reads · 1 command" — the block's header, in the order a reader cares about.
 * The failures are not in it (`workFailed`): a narrow header cuts this line short.
 */
export function workSummary(parts: readonly ConversationPart[]): string {
  const counts: Record<WorkCategory, number> = { edit: 0, read: 0, command: 0, other: 0 };
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    // a todo update is the plan, pinned under the chat, not an edit: TodoWrite would match /write/
    if (!part.skill && !isTodoTool(part.name)) counts[categorize(part.name)] += 1;
  }
  const skills = turnSkills(parts).length;
  return [...(skills > 0 ? [t(skills === 1 ? "{n} skill" : "{n} skills", { n: skills })] : []), ...(Object.keys(counts) as WorkCategory[])
    .filter((category) => counts[category] > 0)
    .map((category) => t(CATEGORY_LABEL[category][counts[category] === 1 ? 0 : 1], { n: counts[category] }))]
    .join(" · ");
}

/**
 * How many calls failed, whatever they were. The folded header says it apart from the counts, where
 * it is never cut: it is what a glance at a finished turn must not miss, and the fold hides the row.
 */
export function workFailed(parts: readonly ConversationPart[]): number {
  return parts.filter((part) => part.kind === "tool" && part.error === true).length;
}

/** "7s" / "1m 12s" for a block header; null when the span is unknown or nonsense. */
export function formatWorkDuration(startTs: string | null, endTs: string | null): string | null {
  if (startTs === null || endTs === null) return null;
  const ms = Date.parse(endTs) - Date.parse(startTs);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t("{s}s", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? t("{m}m {s}s", { m: minutes, s: rest }) : t("{m}m", { m: minutes });
  return t("{h}h {m}m", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/**
 * end_ts is the latest activity time, not proof that an approval-blocked turn finished.
 *
 * `sentOver` is the assistant turn that was last when a message was sent. The pushed status turns
 * `working` before the transcript holds the new user message, so until it does, that finished turn
 * is still the last one and must not be titled as if it were the one running. The turn itself, not
 * its time: a turn may have no `ts`, and the browser's clock and the transcript's need not agree.
 *
 * A turn that ended on its final answer is over as well, with no send from here to say so: an agent
 * at work again is in a turn the transcript does not hold yet (one it began by itself when a
 * background task ended, or a message from the terminal or another device).
 */
export function isLiveWorkTurn(turn: ConversationTurn, last: boolean, status?: string, sentOver?: ConversationTurn | null): boolean {
  if (turn === sentOver) return false;
  if (status === "working" && endedOnAnswer(turn)) return false;
  return last && turn.role === "assistant" && (status === "working" || status === "blocked");
}

/** The turn's last part is its final answer: the agent ended the turn there. */
export function endedOnAnswer(turn: ConversationTurn): boolean {
  const end = turn.parts.at(-1);
  return end?.kind === "text" && end.phase === "final_answer";
}

/**
 * One todo call in a run of them. `state` is the transcript's own word for it (shared/protocol.ts):
 * `unknown` when it records none (Codex after its output, other agents, older servers). Nothing
 * here reads the output text or its emptiness for an outcome.
 */
export interface TodoAttempt {
  part: ToolPart;
  state: "ok" | "pending" | "error" | "unknown";
  /** the list this call left, null when it cannot be read */
  items: TodoItem[] | null;
}

/**
 * Todo calls the agent made one after another, with nothing between them, drawn as one row: the
 * plan's progress without a line per snapshot. Every attempt stays inside it, in order.
 */
export interface TodoGroup {
  /** stable while calls are appended and the page is polled again: the first call's own id, in its turn's row */
  id: string;
  attempts: TodoAttempt[];
  /**
   * The list the row stands for: the latest call that completed (`ok`, or done with no recorded
   * outcome). Null when none did. Its items are null when that list cannot be read; an earlier list
   * never stands in for it.
   */
  current: TodoAttempt | null;
  /** calls that have not answered, and calls that failed (by the transcript's flag) */
  pending: number;
  failed: number;
}

function attemptOf(part: ToolPart): TodoAttempt {
  return { part, state: part.state ?? "unknown", items: todoSnapshot(part) };
}

/**
 * The runs of two or more todo calls in a turn, by their first call. It walks the turn's own parts,
 * before hidden thinking, skills or the answer are taken out: any other part, narration included,
 * ends a run, so nothing the agent did between two updates is folded away. `rowKey` is the turn's
 * row in the timeline; with the first call's original index it names a run whose calls carry no id.
 */
export function todoGroups(parts: readonly ConversationPart[], rowKey: string): Map<ToolPart, TodoGroup> {
  const groups = new Map<ToolPart, TodoGroup>();
  let run: { start: number; parts: ToolPart[] } | null = null;
  const close = () => {
    if (run !== null && run.parts.length > 1) {
      const first = run.parts[0]!;
      const attempts = run.parts.map(attemptOf);
      let current: TodoAttempt | null = null;
      // a call flagged failed never stands for the list, whatever state it carries
      for (const attempt of attempts) if ((attempt.state === "ok" || attempt.state === "unknown") && attempt.part.error !== true) current = attempt;
      groups.set(first, {
        id: JSON.stringify([rowKey, first.call_id ?? `#${run.start}`]),
        attempts,
        current,
        pending: attempts.filter((attempt) => attempt.state === "pending").length,
        failed: attempts.filter((attempt) => attempt.state === "error" || attempt.part.error === true).length,
      });
    }
    run = null;
  };
  parts.forEach((part, index) => {
    if (part.kind === "tool" && !part.skill && isTodoTool(part.name)) {
      if (run === null) run = { start: index, parts: [] };
      run.parts.push(part);
    } else close();
  });
  close();
  return groups;
}

/** The rows a work block draws: skills are chips beside the prompt, thinking only when shown. */
export function visibleWorkParts(parts: ConversationPart[], showThinking: boolean): ConversationPart[] {
  return parts.filter((part) => part.kind !== "skill" && (showThinking || part.kind !== "thinking"));
}

/**
 * Whether the open work block's head says the agent waits for the user ("Needs you") instead of
 * "Working…". By the pane's status, not by a parsed prompt: a blocked pane whose menu no reader
 * knows waits just the same, and a question in Codex's queue leaves Codex working.
 */
export function isWaitingWorkTurn(live: boolean, status?: string): boolean {
  return live && status === "blocked";
}
