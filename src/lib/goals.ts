import type { ConversationPart, GoalWaitSources } from "../../shared/protocol.ts";

/**
 * omo's goal (`create_goal` / `update_goal` / `get_goal`) as the chat shows it on the turn. Each
 * call answers with the goal as it now stands, `{"goal": {objective, status, tokensUsed,
 * timeUsedSeconds, blockedReason?}}`, or `{"goal": null}` when there is none. An answer cut
 * for length (a long objective) loses its JSON: a `create_goal` still has its objective in the
 * call, and is active by definition; an `update_goal` without its answer says nothing usable.
 */

export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "budget_limited";

export interface GoalState {
  objective: string;
  status: GoalStatus;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  blockedReason: string | null;
}

type Tool = Extract<ConversationPart, { kind: "tool" }>;

const STATUSES: readonly string[] = ["active", "paused", "blocked", "complete", "budget_limited"];
const GOAL_TOOLS = new Set(["create_goal", "update_goal", "get_goal"]);

export function isGoalTool(name: string): boolean {
  return GOAL_TOOLS.has(name);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

export function goalOf(part: Tool): GoalState | null {
  if (!isGoalTool(part.name) || part.error) return null;
  const goal = record(record(parse(part.output))?.["goal"]);
  const objective = text(goal?.["objective"]);
  const status = goal?.["status"];
  if (goal !== null && objective !== null && typeof status === "string" && STATUSES.includes(status)) {
    return {
      objective,
      status: status as GoalStatus,
      tokensUsed: count(goal["tokensUsed"]),
      timeUsedSeconds: count(goal["timeUsedSeconds"]),
      blockedReason: text(goal["blockedReason"]),
    };
  }
  const asked = part.name === "create_goal" && part.output_ref !== undefined ? text(record(parse(part.input))?.["objective"]) : null;
  return asked === null ? null : { objective: asked, status: "active", tokensUsed: null, timeUsedSeconds: null, blockedReason: null };
}

export function formatGoalTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type GoalWait = Extract<ConversationPart, { kind: "goal_wait" }>;

/** OmO writes `resumed` as its goal continues: a wait this long past due outlived the OmO that wrote it. */
const GOAL_WAIT_GRACE_MS = 60_000;

export function goalWaitUntil(wait: GoalWait): number {
  return Date.parse(wait.due_at) + GOAL_WAIT_GRACE_MS;
}

export function goalWaitSources(wait: GoalWait): [keyof GoalWaitSources, number][] {
  const kinds: (keyof GoalWaitSources)[] = ["tasks", "monitors", "terminals", "dags", "cells"];
  return kinds.flatMap((kind) => wait.waiting_on[kind] > 0 ? [[kind, wait.waiting_on[kind]] as [keyof GoalWaitSources, number]] : []);
}

function saysNoGoal(part: Tool): boolean {
  if (!isGoalTool(part.name) || part.error) return false;
  const answer = record(parse(part.output));
  return answer !== null && answer["goal"] === null;
}

export function turnGoal(parts: readonly ConversationPart[]): GoalState | null {
  let latest: GoalState | null = null;
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    latest = saysNoGoal(part) ? null : goalOf(part) ?? latest;
  }
  return latest;
}
