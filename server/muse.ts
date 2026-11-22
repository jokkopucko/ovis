/**
 * Muse Code's session log, read into turns. Each line is an envelope (`payload_type`,
 * `recorded_at` in microseconds, `payload`); a run's own events sit in a `runtime.session`
 * payload as `{ kind: "run", event: { kind } }`. The transcript is in a few of them:
 * - a prompt: `runtime.user_intent.accepted`, once per message sent, a steer mid-run included
 *   (`run/started` repeats the words, but not for a steer);
 * - an answer: `assistant_message_committed`, with `phase: "commentary"` for progress prose;
 * - reasoning: `reasoning_summary_committed` (`reasoning_committed` holds encrypted content only);
 * - tool calls: `assistant_tool_calls_committed`, arguments as a JSON string; their results:
 *   `tool_result_batch_committed`, by `tool_call_id` (`task/output` is the stream of them);
 * - a compaction: `context_compaction_installed` with a `summary_text` replacement;
 * - a run's end: `terminal`, whose `completed` makes the answer before it final.
 * Every other record is bookkeeping, and so are the `retained_marker` / `retained_frame` lines.
 * The shapes are the same from Muse 1.4.2 to 1.4.13.
 */
import { closeSync, readSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { openBound } from "./conversation-shared.ts";
import { trimOutput } from "./tool-output.ts";
import { toolSummary } from "./transcript-records.ts";

type Row = Record<string, unknown>;
type Tool = Extract<ConversationPart, { kind: "tool" }>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): Row => isRow(value) ? value : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";

export class MuseUnavailable extends Error {
  constructor() { super("Muse log is in a shape the reader does not know"); this.name = "MuseUnavailable"; }
}

/** Every record Muse 1.4.2 to 1.4.13 writes to a session log, as 160 logs of those builds and the recorded 1.4.13 `/fork` hold them. */
const RECORDS = new Set(["approval_wait.effect.started", "approval_wait.effect.terminal", "async.owner.attempt_admitted", "command.invoked",
  "peer_message.admission.requested", "peer_message.admission.settled", "reminder.cleanup_effect.started", "reminder.cleanup_effect.terminal",
  "run.model.configured", "runtime.branch_seed.diagnostics", "runtime.command_intake.branch.received",
  "runtime.command_intake.conversation_rewind.received", "runtime.command_intake.received", "runtime.command_intake.session_name.received",
  "runtime.command_intake.settled", "runtime.model_reconfigure.completed", "runtime.model_selection.initialized",
  "runtime.reasoning_effort_reconfigure", "runtime.retained_fact", "runtime.session",
  "runtime.session.capture_selection", "runtime.session.message_receipt.read", "runtime.session.message_receipt.state",
  "runtime.session.metadata", "runtime.session.route_facts", "runtime.session.task", "runtime.session.task_source_committed",
  "runtime.session_handoff.goal_safety", "runtime.session_start.intake_v2", "runtime.session_start.intake_v3",
  "runtime.user_intent.accepted", "runtime.user_intent.materialized", "session.end", "session.fork.compaction", "session.fork.created",
  "session.fork.model_prefix", "session.fork.turn", "session.login.completed", "session.name.changed", "session.opened.observed",
  "session.resource_pressure.observed", "session.resumed", "session.side.boundary", "session.side.started", "session.started",
  "session.startup_phases.observed", "session.subscription_entrypoint.impression", "session.workspace_branch.observed",
  "subagent.control.attempt_admitted", "subagent.control.child_session_bound", "subagent.control.owner_command_recorded",
  "subagent.control.owner_state_changed", "subagent.control.result_ready", "subagent.control.resume_context_recorded",
  "subagent.control.runtime_observed", "subagent.control.spawn_accepted", "subagent.control.start_attested",
  "subagent.control.status_updated", "subagent.control.wait_parked", "tool_batch.effect.started", "tool_batch.effect.terminal",
  "user_shell.command", "user_shell.result"]);
/** The kinds of a `runtime.session` payload, and of the events in a run's, in the same logs. */
const SESSION_KINDS = new Set(["agent_tree_initialized", "approval", "run", "security_mode", "task"]);
const RUN_EVENTS = new Set(["assistant_message_committed", "assistant_tool_calls_committed", "context_block_diagnostic", "context_block_updated",
  "context_compaction_candidate", "context_compaction_fallback", "context_compaction_installed", "context_projection_checkpoint",
  "context_projection_checkpoint_skipped", "goal_descendant_attachment", "goal_descendant_launch_accepted", "goal_progress_nudge_fired",
  "goal_run_binding", "goal_usage_attribution", "hook_run_started", "hook_run_terminal", "inbox_delivery_anomaly", "inbox_item_drained",
  "inbox_item_queued", "memory_reminder_child_session_linked", "model_completed", "model_failure_terminal_intent", "model_input_file_uploaded",
  "model_input_trace_recorded", "model_request_configured", "model_response_created", "model_user_messages",
  "provider_request_options_configured", "reasoning_committed", "reasoning_summary_committed", "reasoning_summary_delta",
  "reminder_installed", "reminder_proposal", "reminder_reconciler_outcome", "reminder_snoozed", "resource_usage_sampled",
  "run_fatal_error_classified", "run_retracted", "skill_read_observed", "skill_reminder_decision", "started", "task_backgrounded",
  "task_stream_linked", "terminal", "todo_snapshot_updated", "tool_result_batch_committed", "tool_result_model_visible_content",
  "tool_results_cleared", "user_input_prompt_requested", "user_input_prompt_settled", "user_prompt_display",
  "workflow_child_journal_replay_recorded", "workflow_child_lifecycle", "workflow_launch_reconciled", "workflow_run_launched",
  "workflow_script_fact"]);
const every = (value: unknown, test: (item: Row) => boolean): boolean => Array.isArray(value) && value.every((item) => isRow(item) && test(item));
const optionalText = (value: unknown): boolean => value === undefined || typeof value === "string";

/** The session a log belongs to: Muse names its folder after it. */
export const museSession = (path: string): string => basename(dirname(path));

function known(entry: Row, session: string): boolean {
  if (entry.retained_frame !== undefined) return entry.retained_frame === "session_permission_transaction" && entry.frame_schema_version === 1;
  if (record(entry.stream).kind !== "session" || record(entry.stream).id !== session || entry.schema_version !== 1) return false;
  if (entry.retained_marker !== undefined) return entry.retained_marker === "omitted_live_only";
  // a fork's `session.fork.compaction` has no `recorded_at`, and a turn without one has no time
  if (!RECORDS.has(str(entry.payload_type)) || !isRow(entry.payload)) return false;
  if (entry.payload_type === "runtime.user_intent.accepted") {
    return every(entry.payload.model_messages, (message) => every(message.content, (block) =>
      block.kind === "text" ? typeof block.text === "string" : block.kind === "asset"));
  }
  if (entry.payload_type !== "runtime.session") return true;
  if (!SESSION_KINDS.has(str(entry.payload.kind))) return false;
  if (entry.payload.kind !== "run") return true;
  const event = entry.payload.event;
  if (!isRow(event) || !RUN_EVENTS.has(str(event.kind))) return false;
  if (event.kind === "assistant_message_committed" || event.kind === "reasoning_summary_committed") return typeof event.text === "string";
  if (event.kind === "assistant_tool_calls_committed") return every(event.tool_calls, (call) => typeof call.name === "string" && optionalText(call.call_id));
  if (event.kind === "tool_result_batch_committed") return every(event.results, (item) => typeof item.text === "string" && optionalText(item.tool_call_id));
  if (event.kind === "context_compaction_installed") return isRow(event.replacement) && event.replacement.kind === "summary_text" && typeof event.replacement.text === "string";
  return true;
}

function iso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(Math.floor(value / 1000)).toISOString() : null;
}

export function musePrompt(entry: Row): string | null {
  if (entry.payload_type !== "runtime.user_intent.accepted") return null;
  const blocks = list(record(entry.payload).model_messages).flatMap((message) => list(record(message).content)).map(record);
  const texts = blocks.filter((block) => block.kind === "text" && str(block.text).trim() !== "").map((block) => str(block.text));
  // Muse names each picture `[Image #n]` in the words; a prompt of pictures alone has none
  const pictures = blocks.filter((block) => block.kind === "asset").map((_, n) => `[Image #${n + 1}]`).join(" ");
  return texts.length > 0 ? texts.join("\n\n") : pictures || null;
}

function runEvent(entry: Row): Row | null {
  const payload = record(entry.payload);
  return entry.payload_type === "runtime.session" && payload.kind === "run" ? record(payload.event) : null;
}

/**
 * What a tool's result says, and whether the call failed. Most tools answer with a JSON envelope
 * whose `output` is the text and whose `exit_code` tells how a command ended; any other result is
 * shown as written. A call the harness refused or failed answers `tool denied: …` / `tool failed: …`.
 */
export function museResult(text: string): { text: string; error: boolean } {
  if (text.startsWith("tool denied:") || text.startsWith("tool failed:")) return { text, error: true };
  let parsed: Row;
  try { parsed = record(JSON.parse(text)); } catch { return { text, error: false }; }
  if (typeof parsed.output === "string") return { text: parsed.output, error: typeof parsed.exit_code === "number" && parsed.exit_code !== 0 };
  return { text, error: false };
}

export function parseMuseTranscript(text: string, session: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const calls = new Map<string, Tool>();
  const answer = (ts: string | null, parts: ConversationPart[]): void => {
    const last = turns.at(-1);
    if (last?.role === "assistant") { last.parts.push(...parts); if (ts !== null) last.end_ts = ts; }
    else turns.push({ role: "assistant", ts, ...(ts === null ? {} : { end_ts: ts }), parts });
  };
  const lines = text.split("\n");
  for (const [at, line] of lines.entries()) {
    if (line === "") continue;
    let entry: Row;
    // the last line can be one Muse is still writing
    try { entry = record(JSON.parse(line)); } catch { if (at < lines.length - 1) throw new MuseUnavailable(); continue; }
    if (!known(entry, session)) throw new MuseUnavailable();
    const ts = iso(entry.recorded_at);
    const prompt = musePrompt(entry);
    if (prompt !== null) { turns.push({ role: "user", ts, parts: [{ kind: "text", text: prompt }] }); continue; }
    const event = runEvent(entry);
    if (event === null) continue;
    if (event.kind === "assistant_message_committed" && str(event.text).trim() !== "") {
      answer(ts, [{ kind: "text", text: str(event.text), ...(event.phase === "commentary" ? { phase: "commentary" as const } : {}) }]);
    } else if (event.kind === "reasoning_summary_committed" && str(event.text).trim() !== "") {
      answer(ts, [{ kind: "thinking", text: str(event.text) }]);
    } else if (event.kind === "assistant_tool_calls_committed") {
      const parts: Tool[] = [];
      for (const call of list(event.tool_calls).map(record)) {
        const name = str(call.name) || "tool";
        const input = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
        let args: Row = {};
        try { args = record(JSON.parse(input)); } catch {}
        const part: Tool = { kind: "tool", name, summary: toolSummary(name, args), input, output: "" };
        if (str(call.call_id) !== "") calls.set(str(call.call_id), part);
        parts.push(part);
      }
      if (parts.length > 0) answer(ts, parts);
    } else if (event.kind === "tool_result_batch_committed") {
      for (const item of list(event.results).map(record)) {
        const id = str(item.tool_call_id);
        let part = calls.get(id);
        if (part === undefined) {
          part = { kind: "tool", name: "Tool output", summary: "", input: "", output: "" };
          answer(ts, [part]);
        }
        const result = museResult(str(item.text));
        trimOutput(part, result.text, id);
        if (id === "") { delete part.output_ref; delete part.output_size; }
        if (result.error) part.error = true;
      }
    } else if (event.kind === "terminal" && event.terminal === "completed") {
      // the run ended on its answer: a run that ends on a tool or on progress prose has none
      const last = turns.at(-1);
      const part = last?.role === "assistant" ? last.parts.at(-1) : undefined;
      if (part?.kind === "text" && part.phase === undefined) part.phase = "final_answer";
    } else if (event.kind === "context_compaction_installed") {
      const replacement = record(event.replacement);
      if (replacement.kind === "summary_text" && str(replacement.text).trim() !== "") {
        turns.push({ role: "user", ts, parts: [{ kind: "compact", text: str(replacement.text) }] });
      }
    }
  }
  return turns;
}

export function museModel(text: string, model: string | null): string | null {
  for (const line of text.split("\n")) {
    if (!line.includes('"run.model.configured"') && !line.includes('"model_completed"')) continue;
    let entry: Row;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    const event = runEvent(entry);
    const named = entry.payload_type === "run.model.configured" ? str(record(record(entry.payload).record).model_id)
      : event?.kind === "model_completed" ? str(event.model) : "";
    if (named !== "") model = named;
  }
  return model;
}

export function museToolOutput(path: string, ref: string): string | null {
  const id = JSON.stringify(ref);
  const session = museSession(path);
  let fd: number;
  // another file than the one the lookup is bound to (openBound) holds none of its calls
  try { fd = openBound(path); } catch { return null; }
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    for (let position = 0, got = 0; (got = readSync(fd, chunk, 0, chunk.length, position)) > 0; position += got) {
      const bytes = Buffer.concat([carry, chunk.subarray(0, got)]);
      const end = bytes.lastIndexOf(0x0a) + 1;
      carry = Buffer.from(bytes.subarray(end));
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes(id) || !line.includes('"tool_result_batch_committed"')) continue;
        let entry: Row;
        try { entry = record(JSON.parse(line)); } catch { continue; }
        // a log another session's records replaced has none of this session's calls
        if (record(entry.stream).id !== session) continue;
        const event = runEvent(entry);
        const item = list(event?.results).map(record).find((result) => result.tool_call_id === ref);
        if (item !== undefined) return museResult(str(item.text)).text;
      }
    }
    return null;
  } catch { return null; } finally { closeSync(fd); }
}
