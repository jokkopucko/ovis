import type { ConversationPart } from "../../shared/protocol.ts";
import { parseTodoAnswer, type TodoItem, type TodoStatus } from "../../shared/todos.ts";
export { parseTodoAnswer, type TodoItem, type TodoStatus } from "../../shared/todos.ts";

/**
 * The agent's todo tool calls, as the chat's work block shows them. Each agent keeps its
 * list its own way:
 * - Claude Code `TodoWrite`, opencode `todowrite` and Codex `update_plan` send the whole
 *   list every time (`todowrite` is one word, no underscore, and carries `todos: [{ content, status }]`);
 * - omp / omo `todo`, gjc `todo_write` (and omo's `mcp__…__todo` through Claude) send
 *   operations (init, append, start, done, drop, block, note) on one list, and answer
 *   each call with the whole list as it now stands.
 * A call reads as a one-line summary, and opened, as the list its answer shows.
 */

type Tool = Extract<ConversationPart, { kind: "tool" }>;
type Kind = "whole" | "codex-plan" | "ops";

function toolKind(name: string): Kind | null {
  if (name === "TodoWrite" || name === "todowrite") return "whole";
  if (name === "update_plan") return "codex-plan";
  if (name === "todo" || name === "todo_write" || /^mcp__.+__todo$/.test(name)) return "ops";
  return null;
}

export function isTodoTool(name: string): boolean {
  return toolKind(name) !== null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function args(part: Tool): Record<string, unknown> {
  try { return record(JSON.parse(part.input)); } catch { return {}; }
}

function operations(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input["ops"]) ? input["ops"].map(record) : [input];
}

function phases(list: unknown): TodoItem[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const phase = record(entry);
    const name = text(phase["phase"]);
    const items = Array.isArray(phase["items"]) ? phase["items"] : [];
    return items.flatMap((item) => text(item) === null ? [] : [{ label: text(item)!, phase: name, status: "pending" as TodoStatus }]);
  });
}

/**
 * A whole-list tool's list is its input (`todos` / `plan`); an operations tool's is only its answer:
 * an `init` input is one operation, not the list as it stands, so it is never read as one.
 */
export function todoSnapshot(part: Tool): TodoItem[] | null {
  const kind = toolKind(part.name);
  if (kind === null) return null;
  if (kind === "ops") return parseTodoAnswer(part.output);
  if (part.arguments_omitted) return null;
  let input: unknown;
  try { input = JSON.parse(part.input); } catch { return null; }
  const list = record(input)[kind === "whole" ? "todos" : "plan"];
  if (!Array.isArray(list)) return null;
  const items: TodoItem[] = [];
  for (const entry of list) {
    const fields = record(entry);
    const label = text(fields[kind === "whole" ? "content" : "step"]);
    if (label === null) return null;
    const status = fields["status"];
    // opencode's `todowrite` also sends `cancelled`: an item given up, drawn as dropped
    items.push({ label, phase: null, status: status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : status === "cancelled" ? "dropped" : "pending" });
  }
  return items;
}

export function todoCallSummary(part: Tool): string | null {
  const kind = toolKind(part.name);
  if (kind === null) return null;
  const input = args(part);
  if (kind === "whole" || kind === "codex-plan") {
    const list = Array.isArray(input[kind === "whole" ? "todos" : "plan"]) ? input[kind === "whole" ? "todos" : "plan"] as unknown[] : [];
    const done = list.filter((entry) => record(entry)["status"] === "completed").length;
    return `${done}/${list.length} done`;
  }
  const lines = operations(input).map((op) => {
    const what = text(op["op"]) ?? (Array.isArray(op["list"]) ? "init" : "update");
    if (what === "init") {
      const items = phases(op["list"]);
      return `plan · ${items.length} item${items.length === 1 ? "" : "s"}`;
    }
    if (what === "append") return `add · ${(Array.isArray(op["items"]) ? op["items"] : []).filter((item) => text(item) !== null).length} to ${text(op["phase"]) ?? "list"}`;
    const target = text(op["task"]) ?? text(op["phase"]);
    return target === null ? what : `${what} · ${target}`;
  });
  return lines.join(", ");
}
