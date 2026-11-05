import type { OmoTask } from "../shared/protocol.ts";
import { DETACHED, notificationText } from "./omo-detached.ts";

/**
 * The background commands, monitors and detached eval cells of one OmO session, read from its
 * transcript, for the status line's count and list, as a Claude Code pane's background commands
 * are (claude-subagents.ts). OmO keeps no record file for them: a start is told only by the
 * answer of the call that started it, and an end by the notification OmO wakes its agent with.
 *
 * Starts, in the runtime's own words: `Command running in background with ID: bash_N` (a `bash`
 * call with `run_in_background`), `... auto-detached to background with ID: bash_N` (a command that
 * ran past the foreground window), `Monitor started with ID: mon_X`. Inside eval the calls and their
 * answers are listed in the result's `details.toolCalls` (with the command and the monitor's
 * description); a direct call's answer is its text. A cell's detach is omo-detached.ts's notice.
 *
 * Ends: `Background terminal session bash_N finished: <state>` (senpi-terminal:notification), a
 * monitor's `summary` event (senpi-monitor:notification, matched by id or an unambiguous description
 * when no monitor id matches), `Killed <id>.` (kill_bash), and a cell's notice.
 * Only tool answers and runtime notifications are read: a message that quotes these words is not.
 */
export interface OmoJob {
  id: string;
  kind: "command" | "monitor" | "cell";
  title: string;
  /** when its start was written */
  at: number;
  /** a monitor that outlives restarts: listed, not counted */
  persistent?: boolean;
  /** a monitor's description, which its notifications name it by */
  description?: string;
  ended?: { at: number; status: Exclude<OmoTask["status"], "running" | "lost"> };
}

export interface OmoJobs {
  running: readonly OmoJob[];
  /** newest last, at most ENDED_LIMIT */
  ended: readonly OmoJob[];
  /** Direct monitor arguments waiting for their toolResult, keyed by toolCallId. */
  monitorCalls?: readonly { id: string; title: string; description?: string; persistent: boolean }[];
}

export const NO_JOBS: OmoJobs = { running: [], ended: [] };

const RUNNING_LIMIT = 200;
const ENDED_LIMIT = 20;
const TITLE_LENGTH = 160;
// anchored: an answer starts with the runtime's words; output that quotes them elsewhere is not a start
const STARTS: ReadonlyArray<[RegExp, OmoJob["kind"]]> = [
  [/^Command running in background with ID: (bash_\d+)/, "command"],
  [/^Command is still running; auto-detached to background with ID: (bash_\d+)/, "command"],
  [/^Monitor started with ID: (mon_[A-Za-z0-9]+)/, "monitor"],
];
const LEFT_RUNNING = /(?:^|\n|")Command is still running; auto-detached to background with ID: (bash_\d+)/;
const TERMINAL_END = /Background terminal session (bash_\d+) finished: ([A-Za-z_]+)/g;
const KILLED = /^Killed (\S+?)\.?$/m;
const WATCHER = /watcher ([A-Za-z_]+)/;
const CELL_END = /Detached eval cell (\S+) \((?:js|py)\) (completed|failed|cancelled|was killed)/g;

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const words = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().replace(/\s+/g, " ").slice(0, TITLE_LENGTH) : null;

/** A runtime end word as the list says it: completed, a kill or a signal as cancelled, anything else as failed. */
function endStatus(word: string): NonNullable<OmoJob["ended"]>["status"] {
  if (word === "completed") return "completed";
  if (word === "killed" || word === "cancelled" || word.startsWith("signal_")) return "cancelled";
  return "failed";
}

function started(jobs: OmoJobs, job: OmoJob): OmoJobs {
  if (jobs.running.some((open) => open.id === job.id)) return jobs;
  return { ...jobs, running: [...jobs.running, job].slice(-RUNNING_LIMIT) };
}

function ended(jobs: OmoJobs, match: (job: OmoJob) => boolean, at: number, status: NonNullable<OmoJob["ended"]>["status"]): OmoJobs {
  const index = jobs.running.findIndex(match);
  if (index === -1) return jobs;
  const job = jobs.running[index]!;
  return {
    ...jobs,
    running: jobs.running.filter((_, i) => i !== index),
    ended: [...jobs.ended, { ...job, ended: { at, status } }].slice(-ENDED_LIMIT),
  };
}

/** The starts and kills one answer text reports (a direct call's, or a preview inside eval). */
function fromAnswer(jobs: OmoJobs, text: string, at: number, title: (kind: OmoJob["kind"]) => string, extra: Partial<OmoJob> = {}): OmoJobs {
  let next = jobs;
  for (const [pattern, kind] of STARTS) {
    const id = text.match(pattern)?.[1];
    if (id) next = started(next, { id, kind, title: title(kind), at, ...(kind === "monitor" ? extra : {}) });
  }
  const killed = text.match(KILLED)?.[1];
  if (killed) next = ended(next, (job) => job.id === killed, at, "cancelled");
  return next;
}

const fallbackTitle = (kind: OmoJob["kind"]): string => kind === "monitor" ? "Monitor" : kind === "cell" ? "Eval cell" : "Background command";

/** One session record applied to the jobs so far. */
export function omoJobsAfter(jobs: OmoJobs, entry: unknown): OmoJobs {
  const record = row(entry);
  if (record === null) return jobs;
  const at = typeof record["timestamp"] === "string" ? Date.parse(record["timestamp"]) : NaN;
  if (!Number.isFinite(at)) return jobs;
  if (record["type"] === "custom_message") {
    const kind = record["customType"];
    const text = notificationText(record["content"]);
    let next = jobs;
    if (kind === "senpi-terminal:notification") {
      for (const match of text.matchAll(TERMINAL_END)) next = ended(next, (job) => job.id === match[1], at, endStatus(match[2]!));
    } else if (kind === "senpi-monitor:notification") {
      const monitors = row(record["details"])?.["monitors"];
      const word = text.match(WATCHER)?.[1];
      for (const monitor of Array.isArray(monitors) ? monitors : []) {
        const found = row(monitor);
        const kinds = found?.["kinds"];
        if (!Array.isArray(kinds) || !kinds.includes("summary")) continue;
        const id = found?.["id"];
        const description = found?.["description"];
        // Command-backed notifications carry a process id (bash_N), not the start's mon_X.
        if (typeof id === "string" && next.running.some((job) => job.kind === "monitor" && job.id === id)) {
          next = ended(next, (job) => job.kind === "monitor" && job.id === id, at, endStatus(word ?? "completed"));
        } else {
          const matches = next.running.filter((job) => job.kind === "monitor" && typeof description === "string" && job.description === description);
          if (matches.length === 1) next = ended(next, (job) => job === matches[0], at, endStatus(word ?? "completed"));
          else if (matches.length === 0) {
            // A truncated transcript may omit the assistant call that supplied the description.
            const unknown = next.running.filter((job) => job.kind === "monitor" && job.description === undefined);
            if (unknown.length === 1) next = ended(next, (job) => job === unknown[0], at, endStatus(word ?? "completed"));
          }
        }
      }
    } else if (kind === "senpi-codemode:notification") {
      // a cell's own end, and a command it left behind when it auto-detached
      for (const match of text.matchAll(CELL_END)) {
        next = ended(next, (job) => job.kind === "cell" && job.id === match[1], at, match[2] === "was killed" ? "failed" : endStatus(match[2]!));
      }
      const left = text.match(LEFT_RUNNING)?.[1];
      if (left) next = started(next, { id: left, kind: "command", title: fallbackTitle("command"), at });
    }
    return next;
  }
  if (record["type"] !== "message") return jobs;
  const message = row(record["message"]);
  if (message === null) return jobs;
  if (message["role"] === "assistant" && Array.isArray(message["content"])) {
    let next = jobs;
    for (const block of message["content"]) {
      const call = row(block);
      if (call?.["type"] !== "toolCall" || call["name"] !== "monitor" || typeof call["id"] !== "string") continue;
      const args = row(call["arguments"]);
      const description = args?.["description"];
      next = { ...next, monitorCalls: [
        ...(next.monitorCalls ?? []).filter((pending) => pending.id !== call["id"]),
        { id: call["id"], title: words(description) ?? words(args?.["command"]) ?? fallbackTitle("monitor"),
          ...(typeof description === "string" ? { description } : {}), persistent: args?.["persistent"] === true },
      ].slice(-RUNNING_LIMIT) };
    }
    return next;
  }
  if (message["role"] !== "toolResult") return jobs;
  const tool = message["toolName"];
  const content = notificationText(message["content"]);
  let next = jobs;
  if (tool === "eval") {
    const details = row(message["details"]);
    const cell = content.match(DETACHED)?.[1];
    if (cell) next = started(next, { id: cell, kind: "cell", title: words(details?.["summary"]) ?? fallbackTitle("cell"), at });
    const calls = details?.["toolCalls"];
    if (Array.isArray(calls) && calls.length > 0) {
      for (const call of calls) {
        const found = row(call);
        const preview = found?.["resultPreview"];
        if (found === null || typeof preview !== "string") continue;
        const args = row(found["args"]);
        const description = words(args?.["description"]);
        next = fromAnswer(next, preview, at,
          (kind) => (kind === "monitor" ? description : words(args?.["command"])) ?? fallbackTitle(kind),
          { ...(description ? { description: args?.["description"] as string } : {}), ...(args?.["persistent"] === true ? { persistent: true } : {}) });
      }
    }
  } else if (tool === "monitor") {
    const call = jobs.monitorCalls?.find((pending) => pending.id === message["toolCallId"]);
    if (call) next = { ...next, monitorCalls: jobs.monitorCalls?.filter((pending) => pending !== call) };
    next = fromAnswer(next, content, at, (kind) => call?.title ?? fallbackTitle(kind),
      { ...(call?.description !== undefined ? { description: call.description } : {}), ...(call?.persistent ? { persistent: true } : {}) });
  } else if (tool === "bash" || tool === "kill_bash") {
    next = fromAnswer(next, content, at, fallbackTitle);
  }
  return next;
}

/**
 * The jobs as the list shows them: running ones (oldest first), then those that ended (newest
 * first). One written before the OmO process now holding the session started (`since`) was the
 * previous process's: it is lost, as OmO's own tasks of a dead host are.
 */
export function omoJobTasks(jobs: OmoJobs | undefined, since: number | null): OmoTask[] {
  if (!jobs) return [];
  const task = (job: OmoJob, status: OmoTask["status"], endedAt: number | null): OmoTask => ({
    id: job.id,
    title: job.title,
    category: job.kind === "command" ? "bash" : job.kind === "monitor" ? "monitor" : "eval",
    model: null,
    status,
    started_at: new Date(job.at).toISOString(),
    ended_at: endedAt === null ? null : new Date(endedAt).toISOString(),
    turns: null,
    tool_calls: null,
    tokens: null,
    detail_kind: null,
  });
  const old = (job: OmoJob) => since !== null && job.at < since;
  const running = jobs.running.filter((job) => !old(job)).map((job) => task(job, "running", null));
  const lost = jobs.running.filter(old).map((job) => task(job, "lost", job.at));
  const done = jobs.ended.map((job) => task(job, job.ended!.status, job.ended!.at));
  return [...running, ...[...done, ...lost].sort((a, b) => Date.parse(b.ended_at!) - Date.parse(a.ended_at!))];
}

/** How many of them count as the pane's running background work: cells are counted by omo-detached.ts, persistent monitors not at all. */
export function omoJobCount(jobs: OmoJobs | undefined, since: number | null): number {
  return jobs?.running.filter((job) => job.kind !== "cell" && job.persistent !== true && (since === null || job.at >= since)).length ?? 0;
}
