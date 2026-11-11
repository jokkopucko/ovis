/** Shared native-record rules keep paging, rendering and on-demand results consistent. */
import type { ConversationPart, ConversationTurn, GoalWaitSources, OmoTaskResult } from "../shared/protocol.ts";
import type { SubagentDetail, TaskNotification } from "./claude-subagents.ts";
import { skillInvocationPrompt, skillPromptMessage } from "./skill-activity.ts";
import { trimOutput } from "./tool-output.ts";
import { inlineImageType, ompBlobDigest, ompBlobImageType } from "./codex-images.ts";

type Row = Record<string, unknown>;
export const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const string = (...values: unknown[]): string | undefined => values.find((value) => typeof value === "string") as string | undefined;
export const resultText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map((part) => typeof record(part).text === "string" ? record(part).text : "").join("") : "";

export function isContextClear(value: unknown, source: string): boolean {
  const entry = record(value);
  if (source === "codex-transcript" || source === "scrollback") return false;
  if (source !== "claude-transcript") return entry.type === "custom" && entry.customType === "context_clear";
  const message = record(entry.message);
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || message.role !== "user" || typeof message.content !== "string") return false;
  // Require a whole local-command envelope; quoting /clear in prose is not a reset.
  return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/.test(message.content);
}

/**
 * Another Claude session's message (Claude Code cross-session messaging). It starts the agent's
 * work like a prompt, but nobody typed it here: a notice, sourced `peer:<sender>`. Claude records it
 * as a meta `user` entry when it arrives between turns, and as a queued_command attachment when it
 * arrives mid-turn; both carry `origin: { kind: "peer", name, body }`.
 */
export function claudePeerNotice(value: unknown): Extract<ConversationPart, { kind: "notice" }> | null {
  const entry = record(value);
  const queued = entry.type === "attachment" ? record(entry.attachment) : null;
  if (queued !== null && queued.type !== "queued_command") return null;
  if (queued === null && !(entry.type === "user" && entry.isMeta === true)) return null;
  const origin = record(queued !== null ? queued.origin : entry.origin);
  if (origin.kind !== "peer") return null;
  const envelope = queued !== null ? queued.prompt : record(entry.message).content;
  const parsed = typeof envelope === "string" ? /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(envelope) : null;
  const body = typeof origin.body === "string" ? origin.body : parsed?.[2] ?? "";
  // an unnamed sender leaves the source bare (`peer:`); the chat says "another session" for it
  const name = typeof origin.name === "string" && origin.name.trim() ? origin.name.trim() : /\bfrom-name="([^"]+)"/.exec(parsed?.[1] ?? "")?.[1] ?? "";
  return body.trim() ? { kind: "notice", text: body, source: `peer:${name}` } : null;
}

/**
 * A background subagent's report sent back with SubagentHandback (Claude Code 2.1.30x): another
 * session's message from the subagent's task, a one-line frame, then the report with every line
 * indented two spaces. Its `<task-notification>` then only points at it (CLAUDE_HANDBACK_POINTER). Null for a
 * report longer than a card holds (OMO_TASK_RESULT_MAX): it stays the message it came as, whole.
 */
export function claudeHandback(value: unknown): { taskId: string; report: string } | null {
  const entry = record(value);
  const queued = entry.type === "attachment" ? record(entry.attachment) : null;
  const origin = record(queued !== null ? queued.origin : entry.origin);
  const taskId = typeof origin.senderTaskId === "string" ? origin.senderTaskId : "";
  const framed = typeof origin.body === "string" ? /^\[Subagent hand-back\][^\n]*\n([\s\S]*)$/.exec(origin.body) : null;
  if (origin.kind !== "peer" || !taskId || framed === null) return null;
  // blank rows around the report go, its first line's own indentation (a code block) stays
  const report = framed[1]!.split("\n").map((line) => line.replace(/^ {2}/, "")).join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  return report && report.length <= OMO_TASK_RESULT_MAX ? { taskId, report } : null;
}

/** A subagent's notification result that only says its report came as a SubagentHandback message, and from which task. */
export const CLAUDE_HANDBACK_POINTER = /^This agent's report was delivered to you as a message from "([^"]+)" \(its SubagentHandback call\)/;

/**
 * One delivery of another session's message, as Claude identifies it: the sender and its message id.
 * Claude can record the same delivery twice (queued mid-turn, then echoed as a meta entry); the second
 * record is the same notice. Null when the record does not carry both.
 */
export function claudePeerId(value: unknown): string | null {
  const entry = record(value);
  const queued = entry.type === "attachment" ? record(entry.attachment) : null;
  const origin = record(queued !== null ? queued.origin : entry.origin);
  return origin.kind === "peer" && typeof origin.from === "string" && typeof origin.msg_id === "string" && origin.from && origin.msg_id
    ? `${origin.from}|${origin.msg_id}` : null;
}

/** Pi-family providers use several spellings for the same tool call/result fields. */
export function piMessage(value: unknown): Row | null {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== "message" || message.display === false || entry.display === false) return null;
  const raw = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const content = raw.map((value) => {
    const block = record(value);
    if (block.type === "toolCall") return { ...block, name: string(block.toolName, block.name), id: string(block.toolCallId, block.id, block.callId), arguments: block.toolInput ?? block.input ?? block.arguments };
    if (block.type === "toolResult") return { ...block, toolCallId: string(block.toolCallId, block.callId, block.id), content: block.output ?? block.content ?? block.result };
    return block;
  });
  return { ...message, toolCallId: string(message.toolCallId, message.callId), content };
}

/**
 * One entry's tool results, with the images each carries. pi reads a picture into a tool
 * result as inline base64 beside the text it returns, so only the position is carried in the
 * page: the bytes stay in the file and are fetched when the row is opened, the same way a
 * user-pasted image is. `images` holds one entry per place among that result's pictures (piPictures),
 * the type it shows as or null for a place shown empty, and a ref quotes its place, so a fetch never
 * has to agree with the parse about anything else.
 */
export function piResults(message: Row, blobs?: string | null): { id: string; text: string; error: boolean; images: (string | null)[] }[] {
  const blocks = message.role === "toolResult" ? [message] : Array.isArray(message.content) ? message.content.filter((block) => record(block).type === "toolResult") : [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (typeof block.toolCallId !== "string") return [];
    const images = piPictures(block.content, blobs).map((image) => image.media_type);
    return [{ id: block.toolCallId, text: resultText(block.content), error: block.isError === true, images }];
  });
}

/**
 * The pictures among a record's content blocks, one per place a ref can quote, in order. pi holds a
 * picture inline, by the type its bytes announce (inlineImageType: the same check the image endpoint
 * makes); pi names the type `mimeType` where Claude names it `media_type`. omp moves a picture's bytes
 * to the blob store `blobs` and writes `blob:sha256:<digest>` in their place: such a block takes its
 * place by what the transcript says (ompBlobDigest), and shows as the type its stored bytes announce
 * now (ompBlobImageType: the endpoint's check), or as nothing (`media_type` null) when they are no
 * picture, so a blob that goes missing never moves the next picture into its place. `data` is the
 * inline text or the blob ref.
 */
function piPictures(content: unknown, blobs?: string | null): { media_type: string | null; data: string }[] {
  return (Array.isArray(content) ? content : []).flatMap((value) => {
    const image = record(value);
    if (image.type !== "image" || typeof image.data !== "string") return [];
    const declared = typeof image.mimeType === "string" ? image.mimeType : image.media_type;
    if (blobs && image.data.startsWith("blob:")) return ompBlobDigest(declared, image.data) === null ? [] : [{ media_type: ompBlobImageType(blobs, declared, image.data), data: image.data }];
    const type = inlineImageType(declared, image.data);
    return type === null ? [] : [{ media_type: type, data: image.data }];
  });
}

/** A picture in a pi prompt: the entry it was sent in, and its place among that prompt's pictures. */
export const PI_PROMPT_IMAGE_REF = /^pi-prompt:([A-Za-z0-9_.\-]{1,128}):(\d{1,3})$/;

/** A picture a pi or omp tool returned: the call its result answers (omp's ids hold a `|`), and its place among that result's pictures. */
export const PI_IMAGE_REF = /^pi:([A-Za-z0-9_:.|\-]{1,128}):(\d{1,3})$/;

/**
 * The pictures a pi prompt carries, each with the ref that names it. `message` must come from
 * piMessage. The parser, the turn scanner and the image endpoint all read a prompt's pictures here,
 * so a picture is named exactly when it can be fetched, and a prompt that is only pictures opens a
 * turn exactly when it is drawn as one.
 */
export function piPromptImages(entry: unknown, message: Row, blobs?: string | null): { media_type: string; ref: string; data: string }[] {
  const id = record(entry).id;
  if (message.role !== "user" || !Array.isArray(message.content) || typeof id !== "string") return [];
  return piPictures(message.content, blobs).flatMap(({ media_type, data }, index) => {
    const ref = `pi-prompt:${id}:${index}`;
    return media_type !== null && PI_PROMPT_IMAGE_REF.test(ref) ? [{ media_type, data, ref }] : [];
  });
}

/**
 * The `index`th image of the tool result answering `toolCallId`, decoded. `message` must
 * come from piMessage: pi-family providers spell the content field differently, and the
 * page's ref was built from the normalised one, so reading a raw entry could answer with
 * the wrong block.
 */
export function piImageBlock(message: Row, toolCallId: string, index: number): { media_type: string; data: string } | null {
  // the first result answering the call, as the parser takes it: a second one in the same entry finds
  // its call answered already, and its pictures are never named
  const blocks = message.role === "toolResult" ? [message] : (Array.isArray(message.content) ? message.content : []).filter((block) => record(block).type === "toolResult");
  const block = blocks.map(record).find((value) => value.toolCallId === toolCallId);
  if (block === undefined) return null;
  const image = index >= 0 ? piPictures(block.content)[index] : undefined;
  return image?.media_type ? { media_type: image.media_type, data: image.data } : null;
}

/** Enough turns for a conversation. */
export const MAX_TURNS = 100;

/**
 * Internal IRC deliveries between panes, stored as custom messages. gjc 0.18.12 and omp 18.8.7 write
 * each with `attribution: "agent"`; an older gjc build wrote no attribution, and gjc's own IRC reader
 * takes every record of these types as a delivery. Only one a user is credited with stays a notice.
 */
const GJC_IRC_MESSAGES = new Set(["irc:incoming", "irc:autoreply", "irc:relay"]);

/**
 * gjc wakes the agent with a `custom_message` (a background job's result, `display: true`)
 * in the user's seat: the answer before it is final and the work after it is a new turn.
 * Merging across it buried that answer in the work block. The envelope is chrome.
 */
export function piNotice(value: unknown): Extract<ConversationPart, { kind: "notice" }> | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.display === false || typeof entry.content !== "string") return null;
  if ((entry.attribution === "agent" || entry.attribution === undefined) && typeof entry.customType === "string" && GJC_IRC_MESSAGES.has(entry.customType)) return null;
  const text = entry.content.trim().replace(/^<system-notice>\s*/, "").replace(/\s*<\/system-notice>$/, "").trim();
  if (text.length === 0) return null;
  return typeof entry.customType === "string" ? { kind: "notice", text, source: entry.customType } : { kind: "notice", text };
}

export const OMO_TASK_RESULT_MAX = 16_000;
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const amount = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * OmO continues an active goal on its own with a `goal-continuation` custom message (`display:
 * false`), the TUI's "goal continues" line: the turn after it is the goal's, not an answer to anyone.
 * A notice in the user's seat, its text the objective the message quotes (escaped as OmO writes it).
 */
export function omoGoalContinuation(value: unknown): Extract<ConversationPart, { kind: "notice" }> | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.customType !== "goal-continuation" || typeof entry.content !== "string") return null;
  const quoted = /<untrusted_objective>([\s\S]*?)<\/untrusted_objective>/.exec(entry.content)?.[1];
  const objective = quoted?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&").trim();
  return { kind: "notice", text: objective || entry.content.trim().split("\n")[0]!, source: "goal-continuation" };
}

/** OmO's names for what a goal's wait waits on (`wakeSources`), by GoalWaitSources' names; its wake queue is its own. */
const GOAL_WAIT_SOURCES: Record<string, keyof GoalWaitSources> = {
  "senpi-task": "tasks", "terminal-monitors": "monitors", "terminal-background-sessions": "terminals", "omo-dag": "dags", "senpi-codemode": "cells",
};

/**
 * OmO's goal waiting on background work (`goal-cache-warmup`): `scheduled` names when it continues
 * and what it waits on; any other phase (`resumed`) ends the wait, and so does a record that
 * cannot say when it would continue.
 */
export function omoGoalWait(value: unknown): { wait: Extract<ConversationPart, { kind: "goal_wait" }> | null } | null {
  const entry = record(value);
  if (entry.type !== "custom" || entry.customType !== "goal-cache-warmup") return null;
  const data = record(entry.data);
  const due = amount(data.dueAtMs);
  if (data.phase !== "scheduled" || due === null || Number.isNaN(new Date(due).getTime())) return { wait: null };
  const waiting_on: GoalWaitSources = { tasks: 0, monitors: 0, terminals: 0, dags: 0, cells: 0 };
  for (const [source, count] of Object.entries(record(data.wakeSources))) {
    const kind = GOAL_WAIT_SOURCES[source];
    if (kind !== undefined) waiting_on[kind] = Math.floor(amount(count) ?? 0);
  }
  return { wait: { kind: "goal_wait", due_at: new Date(due).toISOString(), waiting_on } };
}

/**
 * The summaries OmO's `task` calls gave their tasks, by task id: the call's result names the
 * task it started (`details.task_id`, or one `details.items` entry per task of a batch).
 */
export function omoTaskTitles(message: Row, titles: Map<string, string>): void {
  if (message.role !== "toolResult" || message.toolName !== "task") return;
  const details = record(message.details);
  for (const value of Array.isArray(details.items) ? details.items : [details]) {
    const item = record(value);
    const id = label(item.task_id);
    const title = label(item.task_summary) ?? label(item.description);
    if (id !== null && title !== null) titles.set(id, title);
  }
}

/**
 * OmO wakes its agent when a background task ends with a `custom_message` (`omo-senpi:wake`,
 * `display: false`) whose details hold one `senpi-task.completion` per task. It is the only
 * record that the task ended and what it found, so it is drawn in the user's seat as gjc's
 * notice is; a wake that carries no task result (a monitor's event) stays the runtime's.
 */
export function omoTaskResults(value: unknown, titles: ReadonlyMap<string, string>): OmoTaskResult[] | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.customType !== "omo-senpi:wake" || !Array.isArray(entry.details)) return null;
  // one row per task: a task reported twice in one wake is the later report (the rows are keyed by id)
  const tasks = new Map<string, OmoTaskResult>();
  for (const group of entry.details) {
    if (record(group).customType !== "senpi-task.completion" || !Array.isArray(record(group).details)) continue;
    for (const value of record(group).details as unknown[]) {
      const task = record(value);
      const id = label(task.task_id);
      const raw = label(task.status);
      if (id === null || raw === null) continue;
      const stats = record(task.run_stats);
      const agent = label(task.agent_type) ?? label(task.category) ?? label(task.subagent_type);
      const name = label(task.name);
      const result = label(task.final_response) ?? label(task.error) ?? "";
      tasks.set(id, {
        id,
        title: titles.get(id) ?? (name !== null && name !== id ? name : agent ?? id),
        agent,
        model: label(record(task.resolved_model).display) ?? label(task.model),
        status: raw === "completed" ? "completed" : raw === "cancelled" || raw === "canceled" || raw === "aborted" ? "cancelled" : "failed",
        duration_ms: amount(task.duration_ms) ?? amount(stats.runtime_ms),
        turns: amount(stats.turns),
        tool_calls: amount(stats.tool_calls),
        tokens: amount(stats.total_tokens) ?? amount(task.tokens),
        result: result.slice(0, OMO_TASK_RESULT_MAX),
        ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
      });
    }
  }
  return tasks.size > 0 ? [...tasks.values()] : null;
}

/**
 * The card for a Claude Code subagent that ended, from its `<task-notification>` alone and the
 * subagent's meta file (its description and agent type, which never change after it starts), so
 * that a page reads the same from a cold start as from a warm one. The turns, tool calls and
 * tokens a subagent's transcript holds grow with it, and the status line's list shows them.
 */
export function agentTaskResult(notice: TaskNotification, detail: SubagentDetail | undefined): OmoTaskResult {
  const result = notice.result;
  return {
    id: notice.taskId,
    title: detail?.title ?? /^Agent "(.*)"/.exec(notice.summary)?.[1]?.trim() ?? notice.taskId,
    agent: detail?.agent ?? null,
    model: null,
    status: notice.status,
    duration_ms: null,
    turns: null,
    tool_calls: null,
    tokens: null,
    result: result.slice(0, OMO_TASK_RESULT_MAX),
    ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
  };
}

/** The one-line summary a collapsed tool chip shows. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  // an OmO or omp `task` call: the summary it gave the person, one per task of a batch
  if (name === "task") {
    const items = Array.isArray(input["tasks"]) ? input["tasks"].map(record) : [input];
    const titles = items.map((item) => label(item["task_summary"]) ?? label(item["description"])).filter((title) => title !== null);
    if (titles.length > 0) return titles.join(" · ").slice(0, 120);
  }
  // what the agent itself said the call is for: OmO's eval `summary`, the `description` Claude
  // gives a Bash command or a subagent's prompt. Another tool's `description` is its own data.
  const said = typeof input["code"] === "string" ? label(input["summary"])
    : typeof input["command"] === "string" || typeof input["prompt"] === "string" ? label(input["description"]) : null;
  if (said !== null) return said.slice(0, 120);
  // pi names a file `path` where Claude names it `file_path`, and a notebook `notebook_path`.
  const first = input["command"] ?? input["file_path"] ?? input["notebook_path"] ?? input["path"] ?? input["pattern"] ?? input["description"] ?? input["url"];
  return typeof first === "string" ? first.slice(0, 120) : name;
}

/** Complete-record folds with detached, non-committing previews of a final JSONL tail. */
export interface TranscriptParser {
  write(text: string): void;
  snapshot(tail?: string): ConversationTurn[];
}

/** `images`: the pictures of prompts and tool results are named, inline ones (pi) and, with `blobs`,
 * those omp keeps in that blob store. `callIds`: each tool part carries its call's own id (gjc, whose
 * rewrites the chat matches by it) */
type OmpTranscriptOptions = { images?: boolean; blobs?: string | null; callIds?: boolean; taskTitles?: Map<string, string> };

interface OmpParseState {
  turns: ConversationTurn[];
  /** Tool parts still waiting for their result, also referenced by their turn's parts. */
  pending: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  /** The caller's map when parsing a page in stretches; previews must never write to it. */
  taskTitles: Map<string, string>;
  settled: boolean;
  /** The index of the turn that shows OmO's goal waiting (omoGoalWait); only ever the last turn. */
  wait: number | null;
}

function ompParseState(options: OmpTranscriptOptions): OmpParseState {
  return { turns: [], pending: new Map(), taskTitles: options.taskTitles ?? new Map(), settled: false, wait: null };
}

/**
 * Folds new omp records into turns, retaining normalized parts rather than their source records.
 * Adjacent assistant messages merge and tool calls adopt results matched by toolCallId.
 *
 * An assistant message that stopped for good (`stopReason: "stop"`) ends its turn: the next one
 * was woken by something nobody typed, such as omo's hidden monitor or background-task
 * notification. Merging across it folded the answer before it into the next turn's work block.
 */
export function createOmpTranscriptParser(options: OmpTranscriptOptions = {}): TranscriptParser {
  return ompTranscriptParser(ompParseState(options), options.images === true, options.callIds === true, options.blobs ?? null);
}

function ompTranscriptParser(state: OmpParseState, images: boolean, callIds: boolean, blobs: string | null): TranscriptParser {
  const { turns, pending, taskTitles } = state;
  const endWait = (): void => {
    if (state.wait !== null) turns.splice(state.wait, 1);
    state.wait = null;
  };
  const assistantTurn = (ts: string | undefined, speaks: boolean): ConversationTurn => {
    // the agent speaks again: a goal's wait is over, and the turn it would continue is the one before it
    if (speaks) endWait();
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant" && !state.settled) return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  const contentParts = (content: unknown): { type?: string; text?: unknown }[] =>
    Array.isArray(content) ? content.filter((part) => typeof part === "object" && part !== null) : [];

  // a goal's wait holds only while nothing follows it: a turn the last record added after it ends it
  // (an assistant record with nothing to draw opens an empty turn, which is not one)
  const settleWait = (): void => {
    if (state.wait !== null && turns.slice(state.wait + 1).some((turn) => turn.parts.length > 0)) endWait();
  };

  const write = (text: string): void => {
    for (const line of text.split("\n")) {
      settleWait();
      if (line.trim().length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn tail line while omp is mid-append
      }
      if (entry === null || typeof entry !== "object") continue;
      if (isContextClear(entry, "omp-transcript")) { turns.length = 0; pending.clear(); state.wait = null; continue; }
      const timestamp = (entry as { timestamp?: string }).timestamp;
      const goalWait = omoGoalWait(entry);
      if (goalWait !== null) {
        endWait();
        if (goalWait.wait !== null) {
          state.wait = turns.length;
          turns.push({ role: "user", ts: timestamp ?? null, parts: [goalWait.wait] });
        }
        continue;
      }
      // OmO starts a turn nobody typed (a wake, a monitor's event, the goal's continuation): the wait is over
      if (record(entry).type === "custom" && record(entry).customType === "engine-turn-start") { endWait(); continue; }
      const continuation = omoGoalContinuation(entry);
      if (continuation !== null) {
        turns.push({ role: "user", ts: timestamp ?? null, parts: [continuation] });
        continue;
      }
      const skillPrompt = skillPromptMessage(entry);
      if (skillPrompt !== null) {
        turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "text", text: skillPrompt.request }, ...skillPrompt.skills.map((skill) => ({ kind: "skill" as const, skill }))] });
        continue;
      }
      const notice = piNotice(entry);
      if (notice !== null) {
        turns.push({ role: "user", ts: timestamp ?? null, parts: [notice] });
        continue;
      }
      const results = omoTaskResults(entry, taskTitles);
      if (results !== null) {
        turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "task_result", tasks: results }] });
        continue;
      }
      // pi folds old context into a summary of its own accord and on /compact. The entry is a
      // tree entry, not a message, so it reaches the chat only through this branch: the card
      // says where the conversation was cut, and pi keeps answering from the summary onward.
      // piNotice above only claims `custom_message`, so a compaction entry always reaches here.
      if ((entry as { type?: unknown }).type === "compaction") {
        const summary = (entry as { summary?: unknown }).summary;
        if (typeof summary === "string" && summary.trim().length > 0) {
          turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "compact", text: summary, ...compactionTokens(entry) }] });
        }
        continue;
      }
      const message = piMessage(entry);
      if (message === null) continue;
      const applyResults = () => {
        for (const result of piResults(message, blobs)) {
          const tool = pending.get(result.id);
          if (!tool) continue;
          pending.delete(result.id);
          trimOutput(tool, result.text, result.id);
          if (result.error) tool.error = true;
          if (images && result.images.length > 0) {
            // addressed by the call it answers: a nested result shares its entry with other
            // blocks, so the entry id alone could not say which one an image came from
            // named only as the image endpoint takes a ref, so none is named that it cannot answer
            const named = result.images.flatMap((media_type, index) => media_type === null ? [] : [{ media_type, ref: `pi:${result.id}:${index}` }]).filter(({ ref }) => PI_IMAGE_REF.test(ref));
            if (named.length > 0) tool.images = named;
          }
        }
      };
      if (message.role !== "assistant") applyResults();
      omoTaskTitles(message, taskTitles);

      if (message.role === "user") {
        const prompt =
          typeof message.content === "string"
            ? message.content
            : contentParts(message.content)
                .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
                .filter((part) => part.length > 0)
                .join("\n");
        // pictures sent with the prompt, or alone: named here, fetched only when shown
        const pictures = images ? piPromptImages(entry, message, blobs).map(({ media_type, ref }) => ({ kind: "image" as const, media_type, ref })) : [];
        if (prompt.length === 0) {
          if (pictures.length > 0) turns.push({ role: "user", ts: timestamp ?? null, parts: pictures });
          continue;
        }
        // a skill invocation reads as what the user asked, the skill as a chip on it: not as the
        // SKILL.md the runtime put before it. Kept on this record, so no page boundary can part them
        const invocation = skillInvocationPrompt(prompt);
        const asked = invocation === null ? prompt : invocation.request || invocation.skills.map((skill) => `/skill:${skill.name}`).join(" ");
        turns.push({ role: "user", ts: timestamp ?? null, parts: [...pictures, { kind: "text", text: asked }, ...(invocation?.skills ?? []).map((skill) => ({ kind: "skill" as const, skill }))] });
        continue;
      }

      if (message.role === "assistant" && Array.isArray(message.content)) {
        const speaks = message.content.some((block: unknown) => {
          const b = record(block);
          return b.type === "text" ? typeof b.text === "string" && b.text.length > 0
            : b.type === "thinking" ? (typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "").length > 0
            : b.type === "toolCall" && typeof b.name === "string";
        }) || (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.length > 0);
        const turn = assistantTurn(timestamp, speaks);
        if (timestamp) turn.end_ts = timestamp;
        for (const block of message.content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; arguments?: unknown; intent?: unknown };
          if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
            turn.parts.push({ kind: "text", text: b.text, ...(message.stopReason === "stop" ? { phase: "final_answer" as const } : {}) });
          } else if (b.type === "thinking") {
            const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
            if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
          } else if (b.type === "toolCall" && typeof b.name === "string") {
            const input = (typeof b.arguments === "object" && b.arguments !== null ? b.arguments : {}) as Record<string, unknown>;
            const summary = typeof b.intent === "string" && b.intent.length > 0 ? b.intent : toolSummary(b.name, input);
            const part: Extract<ConversationPart, { kind: "tool" }> = {
              kind: "tool",
              name: b.name,
              summary: summary.slice(0, 120),
              input: JSON.stringify(input, null, 2),
              output: "",
              ...(callIds && typeof b.id === "string" ? { call_id: b.id } : {}),
            };
            turn.parts.push(part);
            if (typeof b.id === "string") pending.set(b.id, part);
          }
          // unsupported transcript parts are intentionally ignored
        }
        // A provider can place a result beside its call in the same assistant record.
        applyResults();
        // a failed request (a 401, an overloaded provider) leaves an empty message: without its
        // error the chat showed the prompt with no answer at all
        if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
          turn.parts.push({ kind: "text", text: `Error: ${message.errorMessage}`, failed: true });
        }
        state.settled = message.stopReason === "stop";
      }
    }
    settleWait();
  };

  return {
    write,
    snapshot(tail = ""): ConversationTurn[] {
      if (tail.trim()) {
        // Clone the whole graph together: pending must point at the preview's tool parts,
        // and neither speculative title updates nor settled boundaries may escape it.
        const preview = structuredClone(state);
        ompTranscriptParser(preview, images, callIds, blobs).write(tail);
        return preview.turns.filter((turn) => turn.parts.length > 0);
      }
      return structuredClone(turns.filter((turn) => turn.parts.length > 0));
    },
  };
}

/** The token counts a pi-family compaction record states; a missing, zero or malformed count is left out. */
function compactionTokens(entry: object): { tokens_before?: number; tokens_after?: number; tokens_saved?: number } {
  const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const { tokensBefore, tokensAfter, details } = entry as { tokensBefore?: unknown; tokensAfter?: unknown; details?: { structuralYield?: { savedTokens?: unknown } } | null };
  const before = count(tokensBefore);
  const after = count(tokensAfter);
  // OmO (senpi.compaction.summary.v1) records what its structural pass saved, not the size after
  const saved = typeof details === "object" && details !== null ? count(details.structuralYield?.savedTokens) : undefined;
  return { ...(before !== undefined ? { tokens_before: before } : {}), ...(after !== undefined ? { tokens_after: after } : {}), ...(saved !== undefined ? { tokens_saved: saved } : {}) };
}

/** One-shot parsing shares the incremental record rules, including valid no-newline tails. */
export function parseOmpTranscript(text: string, maxTurns = MAX_TURNS, options: OmpTranscriptOptions = {}): ConversationTurn[] {
  const state = ompParseState(options);
  ompTranscriptParser(state, options.images === true, options.callIds === true, options.blobs ?? null).write(text);
  // No writer survives this call, so its owned turns need no detached snapshot.
  return state.turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}
