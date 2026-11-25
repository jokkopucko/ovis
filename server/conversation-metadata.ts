import { isContextClear, piMessage } from "./transcript-records.ts";
import { piContextWindow } from "./pi-models.ts";
import { cmdContextWindow } from "./cmd.ts";
import { copilotRecords } from "./copilot.ts";
import { museModel } from "./muse.ts";
import { localCommandStdout } from "./claude-transcript.ts";
import { CLAUDE_FAMILY, VERSION } from "./start-screen.ts";
import type { ConversationMetadata, ConversationResponse } from "../shared/protocol.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const label = (value: unknown): string | null => typeof value === "string" && value.trim() && !value.startsWith("<") ? value.trim() : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Claude's standard window; a request past it can only have run in the 1M one. */
const CLAUDE_STANDARD_WINDOW = 200_000;
const CLAUDE_LONG_WINDOW = 1_000_000;

/**
 * Only Codex records its window; a Claude model is known to run in the 1M one once a request
 * went past 200k (and keeps it: a compaction shrinks the use, not the window). A pi model
 * states no window either, so it is looked up in the catalog pi reads its own providers from
 * (`piWindow`); unresolved, no ring is drawn rather than one drawn on a guess.
 */
export function contextOf(used: number, model: string | null, window: number | null, before: ConversationMetadata["context"], piWindow?: (model: string) => number | null): ConversationMetadata["context"] {
  if (used === 0) return before;
  if (window !== null) return { used, window };
  if (piWindow !== undefined) {
    const resolved = model === null ? null : piWindow(model);
    return resolved === null ? { used, window: null } : { used, window: resolved };
  }
  const long = model?.startsWith("claude") && (used > CLAUDE_STANDARD_WINDOW || before?.window === CLAUDE_LONG_WINDOW);
  return { used, window: long ? CLAUDE_LONG_WINDOW : null };
}

// Claude Code's /model answer names the model by its display name: in backticks (2.1.3xx), or bare
// before "and saved" / "for this session" in older versions (bold ones lose the bold to the strip)
const CLAUDE_MODEL_SET = /^Set model to (?:`([^`]+)`|(.+?)(?= and saved | for this session|$))/u;
const CLAUDE_MODEL_NAME = new RegExp(`^(${CLAUDE_FAMILY}) (${VERSION})(?:\\.(0|${VERSION}))?(?: \\(1M context\\))?(?: \\(default\\))?$`, "iu");
// the efforts Claude Code records on its answers (`entry.effort`)
const CLAUDE_EFFORT = "(low|medium|high|xhigh|max)";
const CLAUDE_EFFORT_SET = new RegExp(`^Set effort level to ${CLAUDE_EFFORT}(?= |$)`, "u");
const CLAUDE_MODEL_EFFORT = new RegExp(` with \`${CLAUDE_EFFORT}\` effort$`, "u");

/**
 * What a Claude Code /model or /effort answer set, so the pill follows it before the next answer
 * names it. Only the command's own record counts: a `local_command` entry (for its own command
 * when it names one), or a user entry that is the whole output and was not typed (a prompt carries
 * `origin` or `permissionMode`). Any other answer (kept, refused, a name of another form, an
 * effort no answer records) sets nothing, and the value stays as it was.
 */
function claudeCommandSetting(entry: RecordValue): { model: string | null; effort: string | null } {
  const none = { model: null, effort: null };
  if (entry.isSidechain === true) return none;
  const local = entry.type === "system" && entry.subtype === "local_command";
  const answer = entry.type === "user" && entry.isMeta !== true && !("origin" in entry) && !("permissionMode" in entry);
  if (!local && !answer) return none;
  const said = localCommandStdout(local ? entry.content : record(entry.message).content)?.split("\n")[0];
  if (!said) return none;
  const command = label(record(entry.commandRun).command);
  const set = CLAUDE_MODEL_SET.exec(said);
  if (set && (command === null || command === "model")) {
    const name = CLAUDE_MODEL_NAME.exec(set[1] ?? set[2] ?? "");
    if (!name) return none;
    return { model: `claude-${name[1]!.toLowerCase()}-${name[2]}${name[3] === undefined ? "" : `-${name[3]}`}`, effort: CLAUDE_MODEL_EFFORT.exec(said)?.[1] ?? null };
  }
  const effort = CLAUDE_EFFORT_SET.exec(said);
  return effort && (command === null || command === "effort") ? { model: null, effort: effort[1]! } : none;
}

/**
 * The model and effort one Claude record sets, as parseConversationMetadata reads it: an answer names
 * what it ran at (any answer names its model; one that records an effort names that too, even an
 * empty one), and a /model or /effort answer what it set (claudeCommandSetting).
 */
export function claudeSetting(value: unknown): { model?: string; effort?: string | null } {
  const entry = record(value);
  const set: { model?: string; effort?: string | null } = {};
  const model = entry.type === "assistant" ? label(record(entry.message).model) : null;
  if (model) set.model = model;
  if (entry.type === "assistant" && "effort" in entry) set.effort = label(entry.effort);
  const command = claudeCommandSetting(entry);
  if (command.model) set.model = command.model;
  if (command.effort) set.effort = command.effort;
  return set;
}

/**
 * What an omp-shaped fold knows past the metadata it returns: the provider the last record named,
 * which an answer that names none still ran at (and which the pill no longer shows). A fold that
 * continues another one is handed the same object, so it reads its text as one fold would.
 */
export interface MetadataFold { piProvider: string | null }

/** Codex turn_context is a snapshot; omp/omo setting changes are separate events. */
export function parseConversationMetadata(text: string, source: ConversationResponse["source"], before?: ConversationMetadata, piAgentDir?: string | null, fold?: MetadataFold): ConversationMetadata {
  const metadata: ConversationMetadata = before ? { ...before } : { model: null, reasoning_effort: null };
  // Agy's exported rows do not attest the selected model or reasoning effort.
  if (source === "agy-transcript") return metadata;
  // Letta's transcript names no model or effort
  if (source === "letta-transcript") return metadata;
  // Kimi's loop names the model and thinking effort on every request.
  if (source === "kimi-transcript") {
    for (const line of text.split("\n")) {
      if (!line.includes('"llm.request"')) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; kind?: unknown; model?: unknown; thinkingEffort?: unknown } | null;
        if (record === null || record.type !== "llm.request" || record.kind === "compaction") continue;
        if (typeof record.model === "string") metadata.model = record.model;
        if (typeof record.thinkingEffort === "string") metadata.reasoning_effort = record.thinkingEffort;
      } catch { /* a partial line: the next read has it whole */ }
    }
    return metadata;
  }
  if (source === "copilot-transcript") {
    for (const { type, data } of copilotRecords(text)) {
      const model = type === "session.start" ? label(data.selectedModel)
        : type === "session.model_change" ? label(data.newModel)
        : type === "session.resume" ? label(data.selectedModel)
        : type === "assistant.message" ? label(data.model) : null;
      if (model) metadata.model = model;
      if (type === "session.start" || type === "session.model_change" || type === "session.resume") {
        if ("reasoningEffort" in data) metadata.reasoning_effort = label(data.reasoningEffort);
      }
    }
    return metadata;
  }
  // Muse names its model, but no effort or context window; most of its lines are skipped unparsed
  if (source === "muse-transcript") return { ...metadata, model: museModel(text, metadata.model) };
  // pi states the provider on the same records that state usage, so the window is asked for
  // from what this line says rather than remembered across sources
  let piProvider: string | null = fold?.piProvider ?? null;
  // the catalogs cannot change within one fold, so each model is looked up (and its files
  // stat'ed) once, not once per answer
  const piWindows = new Map<string, number | null>();
  const piWindow = (model: string): number | null => {
    if (piAgentDir === null) return null;
    const key = JSON.stringify([piProvider, model]);
    if (!piWindows.has(key)) piWindows.set(key, piContextWindow(model, piProvider, piAgentDir));
    return piWindows.get(key)!;
  };
  for (const line of text.split("\n")) {
    let entry: RecordValue;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (isContextClear(entry, source)) { metadata.model = null; metadata.reasoning_effort = null; piProvider = null; delete metadata.context; delete metadata.provider; continue; }
    if (source === "grok-transcript") {
      const update = record(record(entry.params).update);
      if (entry.method === "session/update" && update.sessionUpdate === "user_message_chunk") {
        const model = label(record(update._meta).modelId);
        if (model) metadata.model = model;
      }
    } else if (source === "codex-transcript") {
      const event = record(entry.payload);
      if (entry.type === "event_msg" && event.type === "token_count") {
        const info = record(event.info);
        const window = count(info.model_context_window);
        metadata.context = contextOf(count(record(info.last_token_usage).total_tokens), metadata.model, window || null, metadata.context);
        continue;
      }
      if (entry.type !== "turn_context" && entry.type !== "session_meta") continue;
      const payload = record(entry.payload);
      const settings = record(record(payload.collaboration_mode).settings);
      const model = label(payload.model) ?? label(settings.model);
      const effort = "effort" in payload ? payload.effort
        : "reasoning_effort" in payload ? payload.reasoning_effort : settings.reasoning_effort;
      if (model) metadata.model = model;
      if (model || effort !== undefined) metadata.reasoning_effort = label(effort);
    } else if (source === "omp-transcript" || source === "omo-transcript" || source === "gjc-transcript" || source === "pi-transcript" || source === "cmd-transcript") {
      if (entry.type === "model_change") {
        // pi and omo name `provider` and `modelId`; omp names one `model`, "provider/id", where
        // the id is what its answers name as their model
        const named = label(entry.model);
        const slash = named?.indexOf("/") ?? -1;
        metadata.model = label(entry.modelId) ?? (slash > 0 ? named!.slice(slash + 1) : named);
        piProvider = label(entry.provider) ?? (slash > 0 ? named!.slice(0, slash) : null);
        if (source !== "cmd-transcript") {
          if (piProvider === null) delete metadata.provider; else metadata.provider = piProvider;
        }
      }
      if (entry.type === "thinking_level_change") metadata.reasoning_effort = label(entry.thinkingLevel);
      const message = piMessage(entry) ?? {};
      if (entry.type === "message" && message.role === "assistant" && label(message.model)) {
        metadata.model = label(message.model);
        if (source === "cmd-transcript") piProvider = "commandcode";
        else if (label(message.provider)) piProvider = metadata.provider = label(message.provider)!;
        else delete metadata.provider;
      }
      if (entry.type === "message" && message.role === "assistant") {
        const usage = record(message.usage);
        if (source === "cmd-transcript") {
          // cmd (Command Code) uses camelCase usage fields and resolves its window through
          // the commandcode catalog; otherwise it is pi-shaped (counts the answer too)
          const filled = message.stopReason === "error" || message.stopReason === "aborted" ? 0
            : count(usage.totalTokens) || count(usage.inputTokens) + count(usage.outputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens);
          const window = metadata.model === null ? null : cmdContextWindow(metadata.model);
          metadata.context = contextOf(filled, metadata.model, window, metadata.context);
        } else if (source !== "pi-transcript") {
          metadata.context = contextOf(count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite), metadata.model, null, metadata.context);
          continue;
        } else {
          // pi's own figure for what one request filled: it counts the answer too, and leaves a
          // failed or aborted request out, which filled nothing
          const filled = message.stopReason === "error" || message.stopReason === "aborted" ? 0
            : count(usage.totalTokens) || count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite);
          metadata.context = contextOf(filled, metadata.model, null, metadata.context, piWindow);
        }
      }
    } else if (source === "claude-transcript") {
      const message = record(entry.message);
      const set = claudeSetting(entry);
      if (set.model !== undefined) metadata.model = set.model;
      if (set.effort !== undefined) metadata.reasoning_effort = set.effort;
      // a prompt carries the mode it was sent under, and a switch is recorded as its own entry; a subagent has its own
      const mode = entry.isSidechain !== true && (entry.type === "user" || entry.type === "permission-mode") ? label(entry.permissionMode) : null;
      if (mode) metadata.permission_mode = mode;
      if (entry.type === "assistant" && entry.isSidechain !== true && label(message.model)) {
        const usage = record(message.usage);
        metadata.context = contextOf(count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens), metadata.model, null, metadata.context);
      }
    }
  }
  if (fold) fold.piProvider = piProvider;
  return metadata;
}
