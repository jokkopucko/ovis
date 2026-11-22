import type { OmoRun, OmoTask } from "../../shared/protocol.ts";

export function spanMs(startedAt: string | null, endedAt: string | null, running: boolean, now: number): number | null {
  const started = startedAt === null ? NaN : Date.parse(startedAt);
  const ended = running ? now : endedAt === null ? NaN : Date.parse(endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
}

export function taskElapsedMs(task: OmoTask, now: number): number | null {
  return spanMs(task.started_at, task.ended_at, task.status === "running", now);
}

export function runGoing(run: OmoRun): boolean {
  return run.status === "running" || run.status === "pending" || run.status === "paused";
}

export function endedSummary(tasks: OmoTask[], runs: OmoRun[]): { ended: number; failed: number } {
  const endedTasks = tasks.filter((task) => task.status !== "running");
  const endedRuns = runs.filter((run) => !runGoing(run));
  return {
    ended: endedTasks.length + endedRuns.length,
    failed: endedTasks.filter((task) => task.status === "failed" || task.status === "lost").length + endedRuns.filter((run) => run.status === "failed").length,
  };
}

export function clockOffsetMs(serverTime: string | null, receivedAt: number): number {
  const server = serverTime === null ? NaN : Date.parse(serverTime);
  return Number.isFinite(server) ? server - receivedAt : 0;
}

export interface TaskCallItem { title: string; agent: string | null; prompt: string }

/**
 * The tasks one `task` call starts: OmO's single call (`task_summary`, `description`, `prompt`,
 * `subagent_type` or `category`) or batch (`tasks`, each item taking the call's agent unless it
 * names its own), and omp's batch (`agent`, items with `description` and `assignment`). Null when
 * the input is no such call.
 */
export function taskCallItems(input: Record<string, unknown>): TaskCallItem[] | null {
  const str = (row: Record<string, unknown>, ...keys: string[]): string | null => {
    for (const key of keys) { const value = row[key]; if (typeof value === "string" && value.trim().length > 0) return value.trim(); }
    return null;
  };
  const agentOf = (row: Record<string, unknown>): string | null => str(row, "subagent_type", "agent", "category");
  const shared = agentOf(input);
  const rows = Array.isArray(input["tasks"]) ? input["tasks"] : [input];
  const items = rows.flatMap((value, index): TaskCallItem[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const prompt = str(row, "prompt", "assignment") ?? "";
    const title = str(row, "task_summary", "description", "name", "id");
    if (title === null && prompt.length === 0) return [];
    return [{ title: title ?? `#${index + 1}`, agent: agentOf(row) ?? shared, prompt }];
  });
  return items.length > 0 ? items : null;
}

/**
 * OmO's agents often frame theirs in bare section tags on
 * lines of their own (`<analysis>` … `</analysis>`, `<next_steps>`): an opening tag becomes the
 * section's name in bold, a closing one goes. Tags inside a code block, and any line with more
 * on it than the tag, are the answer's own and stay.
 */
export function taskResultMarkdown(text: string): string {
  let fenced = false;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (fenced ? /^\s{0,3}```\s*$/.test(line) : /^ {0,3}```/.test(line)) { fenced = !fenced; lines.push(line); continue; }
    const tag = fenced ? null : /^\s*<(\/?)([a-z][a-z0-9_-]*)>\s*$/.exec(line);
    if (tag === null) { lines.push(line); continue; }
    if (tag[1] === "/") continue;
    const name = tag[2]!.replace(/[_-]+/g, " ");
    lines.push(`**${name[0]!.toUpperCase()}${name.slice(1)}**`);
  }
  return lines.join("\n").trim();
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
