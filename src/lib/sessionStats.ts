import { useSyncExternalStore } from "react";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { formatBytes } from "./bridgeProgress.ts";
import { formatGoalTime, turnGoal, type GoalState, type GoalStatus } from "./goals.ts";
import { t } from "./i18n.ts";

export interface SessionStats {
  workedSeconds: number | null;
  complete: boolean;
  bytes: number | null;
  goal: GoalState | null;
}

export function sessionStats(turns: readonly ConversationTurn[], complete: boolean, bytes: number | null): SessionStats {
  let worked: number | null = null;
  let unknown = false;
  const last = turns.at(-1);
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const ms = turn.ts === null || turn.end_ts === undefined ? NaN : Date.parse(turn.end_ts) - Date.parse(turn.ts);
    if (Number.isFinite(ms) && ms >= 0) worked = (worked ?? 0) + ms;
    else if (turn !== last) unknown = true;
  }
  return {
    workedSeconds: worked === null ? null : Math.round(worked / 1000),
    complete: complete && !unknown,
    bytes,
    goal: turnGoal(turns.flatMap((turn) => turn.role === "assistant" ? turn.parts : [])),
  };
}

const sameGoal = (a: GoalState | null, b: GoalState | null): boolean => a === b || (a !== null && b !== null
  && a.objective === b.objective && a.status === b.status && a.tokensUsed === b.tokensUsed && a.timeUsedSeconds === b.timeUsedSeconds && a.blockedReason === b.blockedReason);

const same = (a: SessionStats | undefined, b: SessionStats | null): boolean => a === undefined ? b === null
  : b !== null && a.workedSeconds === b.workedSeconds && a.complete === b.complete && a.bytes === b.bytes && sameGoal(a.goal, b.goal);

const published = new Map<string, Map<symbol, SessionStats>>();
const listeners = new Set<() => void>();
const keyOf = (machineId: string, paneId: string): string => `${machineId}\0${paneId}`;

function current(key: string): SessionStats | null {
  return [...published.get(key)?.values() ?? []].at(-1) ?? null;
}

export function publishSessionStats(machineId: string, paneId: string, view: symbol, stats: SessionStats | null): void {
  const key = keyOf(machineId, paneId);
  const views = published.get(key) ?? new Map<symbol, SessionStats>();
  if (same(views.get(view), stats)) return;
  const before = current(key);
  views.delete(view);
  if (stats !== null) views.set(view, stats);
  if (views.size === 0) published.delete(key);
  else published.set(key, views);
  if (current(key) !== before) for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSessionStats(machineId: string, paneId: string | null): SessionStats | null {
  return useSyncExternalStore(subscribe, () => paneId === null ? null : current(keyOf(machineId, paneId)));
}

const STATUS_WORDS: Record<GoalStatus, string> = {
  active: "in progress", paused: "paused", blocked: "blocked", complete: "complete", budget_limited: "out of budget",
};

export function goalStatusWord(status: GoalStatus): string {
  return t(STATUS_WORDS[status]);
}

export function workedWords(stats: SessionStats): string | null {
  if (stats.workedSeconds === null) return null;
  const duration = formatGoalTime(stats.workedSeconds);
  return stats.complete ? t("Worked {duration}", { duration }) : t("Worked at least {duration}", { duration });
}

export function sizeWords(stats: SessionStats): string | null {
  return stats.bytes === null ? null : formatBytes(stats.bytes);
}

export function sessionMenuLines(stats: SessionStats): { totals: string; goal: string | null } {
  const totals = [
    workedWords(stats) ?? t("Work time unknown"),
    stats.bytes === null ? t("Transcript size unknown") : t("Transcript {size}", { size: formatBytes(stats.bytes) }),
  ].join(" · ");
  const goal = stats.goal;
  if (goal === null) return { totals, goal: null };
  const spent = goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 ? [formatGoalTime(goal.timeUsedSeconds)] : [];
  return { totals, goal: [t("Goal: {objective}", { objective: goal.objective }), goalStatusWord(goal.status), ...spent].join(" · ") };
}
