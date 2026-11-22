import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { matchPart, searchPattern } from "../../shared/conversation-search.ts";
import { turnSkills } from "./skillActivity.ts";
import { isTodoTool, todoSnapshot, type TodoItem } from "./todos.ts";
import { t } from "./i18n.ts";

export type ToolPart = Extract<ConversationPart, { kind: "tool" }>;
export type ThinkingPart = Extract<ConversationPart, { kind: "thinking" }>;
export type TextPart = Extract<ConversationPart, { kind: "text" }>;

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

export type TurnSegment = { kind: "work"; start: number; parts: ConversationPart[] } | { kind: "answer"; start: number; parts: TextPart[] };
export type WorkSegment = Extract<TurnSegment, { kind: "work" }>;

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

export type AnswerItem = { kind: "text"; part: TextPart } | { kind: "failed"; parts: TextPart[] };

export function answerItems(parts: readonly TextPart[], requestDetails: boolean): AnswerItem[] {
  const items: AnswerItem[] = [];
  for (const part of parts) {
    const last = items.at(-1);
    if (!requestDetails || part.failed !== true) items.push({ kind: "text", part });
    else if (last?.kind === "failed") last.parts.push(part);
    else items.push({ kind: "failed", parts: [part] });
  }
  return items;
}

export function foldedRequestsMatch(turn: ConversationTurn, match: string): number | null {
  const pattern = searchPattern(match);
  const index = pattern === null ? undefined : matchPart(turn, pattern);
  const part = index === undefined ? undefined : turn.parts[index];
  if (turn.role === "user" || part?.kind !== "text" || part.failed !== true) return null;
  for (const segment of turnSegments(turn.parts)) {
    if (segment.kind === "work") continue;
    const row = answerItems(segment.parts, true).find((item) => item.kind === "failed" && item.parts.includes(part));
    if (row?.kind === "failed") return turn.parts.indexOf(row.parts[0]!);
  }
  return null;
}

export function workStartsOpen(live: boolean, parts: ConversationPart[]): boolean {
  if (live) return true;
  const lastAnswer = splitTurn(parts).answer.at(-1);
  const after = lastAnswer === undefined ? 0 : parts.lastIndexOf(lastAnswer) + 1;
  return parts.slice(after).some((part) => part.kind === "text" && part.text.trim().length > 0);
}

export function workBlockStartsOpen(block: { live: boolean; waiting: boolean; last: boolean }, parts: ConversationPart[], foldWork: boolean): boolean {
  if (foldWork) return block.waiting;
  return block.live || (block.last && workStartsOpen(false, parts));
}

type WorkCategory = "edit" | "read" | "command" | "other";

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

export function workFailed(parts: readonly ConversationPart[]): number {
  return parts.filter((part) => part.kind === "tool" && part.error === true).length;
}

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
 */
export function isLiveWorkTurn(turn: ConversationTurn, last: boolean, status?: string, sentOver?: ConversationTurn | null): boolean {
  if (turn === sentOver) return false;
  if (status === "working" && endedOnAnswer(turn)) return false;
  return last && turn.role === "assistant" && (status === "working" || status === "blocked");
}

export function endedOnAnswer(turn: ConversationTurn): boolean {
  const end = turn.parts.at(-1);
  return end?.kind === "text" && end.phase === "final_answer";
}

/**
 * `state` is the transcript's own word for it (shared/protocol.ts):
 * `unknown` when it records none (Codex after its output, other agents, older servers).
 */
export interface TodoAttempt {
  part: ToolPart;
  state: "ok" | "pending" | "error" | "unknown";
  items: TodoItem[] | null;
}

export interface TodoGroup {
  id: string;
  attempts: TodoAttempt[];
  current: TodoAttempt | null;
  pending: number;
  failed: number;
}

function attemptOf(part: ToolPart): TodoAttempt {
  return { part, state: part.state ?? "unknown", items: todoSnapshot(part) };
}

export function todoGroups(parts: readonly ConversationPart[], rowKey: string): Map<ToolPart, TodoGroup> {
  const groups = new Map<ToolPart, TodoGroup>();
  let run: { start: number; parts: ToolPart[] } | null = null;
  const close = () => {
    if (run !== null && run.parts.length > 1) {
      const first = run.parts[0]!;
      const attempts = run.parts.map(attemptOf);
      let current: TodoAttempt | null = null;
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

export function visibleWorkParts(parts: ConversationPart[], showThinking: boolean): ConversationPart[] {
  return parts.filter((part) => part.kind !== "skill" && (showThinking || part.kind !== "thinking"));
}

/**
 * By the pane's status, not by a parsed prompt: a blocked pane whose menu no reader
 * knows waits just the same, and a question in Codex's queue leaves Codex working.
 */
export function isWaitingWorkTurn(live: boolean, status?: string): boolean {
  return live && status === "blocked";
}
