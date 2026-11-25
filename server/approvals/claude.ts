/**
 * Claude Code's adapter to the approval hub (server/approvals/hub.ts): its approvals of a shell command, a file it
 * writes or edits, a page it fetches and an MCP tool through its own PermissionRequest hook, its turns through its
 * UserPromptSubmit and Stop hooks, and the commands it ran through its PostCompact, SessionStart and UserPromptExpansion
 * hooks. The hooks go in a `--settings` file (0600, in the hub's folder), never the user's
 * settings.
 * Measured on Claude Code 2.1.330:
 * - the terminal draws its own dialog while the hook waits, and whichever answers first wins;
 * - answered in the terminal, the hook's request stays open and a later answer to it is ignored, so a request the
 *   screen no longer shows is released (answered with no decision);
 * - a hook that ends with no decision leaves the terminal's dialog as it is, at once.
 * So every card still has its keys: the hook is only how a Yes or No goes when it holds the very request on screen.
 */
import { isAbsolute, relative } from "node:path";

import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import { settingsFile } from "../claude-settings-file.ts";
import type { ApprovalAdapter, ApprovalDecision, ApprovalRequest } from "./hub.ts";

/**
 * The first Claude Code that draws a Bash dialog's command between dashed rules (its changelog), which is what a held
 * request is bound to (dialogs/claude.ts). An earlier one would bind nothing, so it gets no hook.
 */
export const CLAUDE_HOOK_MIN_VERSION = "2.1.286";

/**
 * The tools whose approval a card shows from the hook's request. Monitor too: under a Bash-only matcher Claude Code
 * posts a Monitor command as a Bash call, whose allow it then ignores (its hooks reference, 2.1.314 on); matched by name
 * it comes as itself, and is left to the terminal (toCard).
 */
const MATCHER = "^(?:Bash|Monitor|Edit|Write|WebFetch|mcp__.+)$";

/**
 * The hooks that tell a command Claude ran (command), each matched to the case that is one: a SessionStart's matcher is its
 * source, a PostCompact's its trigger. Every other start, resume and compact runs no hook of Ovis's.
 */
const COMMAND_EVENTS: Record<string, string | null> = { PostCompact: "manual", SessionStart: "clear", UserPromptExpansion: null };
/** Seconds Claude waits on such a hook at most (its default is ten minutes) */
const TOLD_TIMEOUT_S = 10;

/** Yes allows and No declines; any other option of the dialog goes as its keys. */
export function permissionDecision(label: string): ApprovalDecision | null {
  return label === "Yes" ? "allow" : /^No\b/.test(label) ? "deny" : null;
}

export const claudeApprovals: ApprovalAdapter = {
  kind: "claude",

  supports: (version) => meetsMinVersion(version, CLAUDE_HOOK_MIN_VERSION),

  /**
   * An inline JSON `--settings` the launch already has (the dialog's) goes into the hook's file with it; a `--settings`
   * that names a file, or more than one, could not be merged, and gets no hook.
   */
  launchArgs(args, hook, dir) {
    const given = args ?? [];
    const end = given.indexOf("--");
    const flags = end < 0 ? given : given.slice(0, end);
    const at = flags.flatMap((arg, index) => arg === "--settings" || arg.startsWith("--settings=") ? [index] : []);
    if (at.length > 1) return null;
    let settings: Record<string, unknown> = {};
    let replaced: { from: number; to: number } | null = null;
    if (at.length === 1) {
      const index = at[0]!;
      const inline = flags[index] === "--settings";
      const value = inline ? flags[index + 1] : flags[index]!.slice("--settings=".length);
      if (value === undefined) return null;
      try {
        const parsed: unknown = JSON.parse(value.trim().startsWith("{") ? value : "null");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        settings = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
      replaced = { from: index, to: index + (inline ? 2 : 1) };
    }
    const hooks = typeof settings["hooks"] === "object" && settings["hooks"] !== null && !Array.isArray(settings["hooks"])
      ? { ...(settings["hooks"] as Record<string, unknown>) } : {};
    const theirs = (event: string): unknown[] => Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    // exec form: no shell between Claude and the relay, on any platform
    const relay = [{ type: "command", command: hook.command, args: hook.args }];
    hooks["PermissionRequest"] = [...theirs("PermissionRequest"), { matcher: MATCHER, hooks: relay }];
    for (const event of ["UserPromptSubmit", "Stop"]) hooks[event] = [...theirs(event), { hooks: relay }];
    // told only of what is a command (command), and never waited on for long: the hub answers them at once
    const told = [{ ...relay[0]!, timeout: TOLD_TIMEOUT_S }];
    for (const [event, matcher] of Object.entries(COMMAND_EVENTS)) hooks[event] = [...theirs(event), { ...(matcher ? { matcher } : {}), hooks: told }];
    const path = settingsFile(JSON.stringify({ ...settings, hooks }), dir);
    if (replaced === null) return ["--settings", path, ...given];
    return [...given.slice(0, replaced.from), "--settings", path, ...given.slice(replaced.to)];
  },

  toCard(event) {
    const input = event as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; cwd?: unknown } | null;
    if (typeof input !== "object" || input === null || input.hook_event_name !== "PermissionRequest" || typeof input.tool_name !== "string") return null;
    const tool = input.tool_input;
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return null;
    return requestOf(input.tool_name, tool as Record<string, unknown>, typeof input.cwd === "string" ? input.cwd : null);
  },

  /**
   * A prompt begins a turn; a Stop ends the turn of its prompt (both carry its id, 2.1.330), unless background tasks or
   * scheduled ones are still there (it lists them), whose notice can start a turn with no prompt: that rest stays the
   * screen's and transcript's.
   */
  turn(event) {
    const input = event as { hook_event_name?: unknown; prompt_id?: unknown; background_tasks?: unknown; session_crons?: unknown } | null;
    const name = input?.hook_event_name;
    const prompt = typeof input?.prompt_id === "string" && input.prompt_id !== "" ? input.prompt_id : null;
    if (name === "UserPromptSubmit") return { turn: "began", prompt };
    if (name !== "Stop") return null;
    const none = (list: unknown) => list === undefined || (Array.isArray(list) && list.length === 0);
    return none(input!.background_tasks) && none(input!.session_crons) ? { turn: "ended", prompt } : null;
  },

  /**
   * Measured on 2.1.330, where its own commands tell no UserPromptSubmit: a `/compact` the user ran ends with a manual
   * PostCompact, a `/clear` starts the next session with a SessionStart from `clear`, and a skill or custom command comes
   * as a UserPromptExpansion that names it. A compact Claude began by itself, and a session it started or resumed, are
   * no command.
   */
  command(event) {
    const input = event as { hook_event_name?: unknown; trigger?: unknown; source?: unknown; command_name?: unknown; command_args?: unknown } | null;
    switch (input?.hook_event_name) {
      case "PostCompact": return input.trigger === "manual" ? { name: "compact", builtin: true } : null;
      case "SessionStart": return input.source === "clear" ? { name: "clear", builtin: true } : null;
      case "UserPromptExpansion": return text(input.command_name) === null ? null
        : { name: input.command_name as string, builtin: false, ...(typeof input.command_args === "string" ? { args: input.command_args } : {}) };
      default: return null;
    }
  },

  decision: permissionDecision,

  toAnswer(decision) {
    if (decision === null) return "{}";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        // No, as the terminal's No: Claude stops and waits for the user
        decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "The user declined this command in Ovis.", interrupt: true },
      },
    });
  },
};

const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * A file's path as Claude Code's file dialog draws it, its subject: relative to the folder it works in (2.1.330 drew
 * `../outside-dir/out.txt` for a file beside it). The card names a file outside that folder by its whole path.
 */
function paths(path: string, cwd: string | null): { shown: string; card: string } {
  if (cwd === null || !isAbsolute(path)) return { shown: path, card: path };
  const shown = relative(cwd, path) || path;
  return { shown, card: shown.startsWith("..") ? path : shown };
}

/** Each line of a text under its mark, as a diff shows it: none for an empty text. */
const marked = (mark: string, value: string): string[] => value === "" ? [] : value.split("\n").map((line) => `${mark} ${line}`);

/**
 * The card a tool's request makes, or null for one left to the terminal: a Monitor command, a tool not named here, or a
 * request missing what its card shows. A card shows the whole of what is allowed: a shell command; the file's path and
 * the text written to it whole, or the lines an edit takes out and puts in; the address fetched and what is asked of the
 * page, as the dialog shows them; an MCP tool's name and each of its arguments, as the dialog shows them.
 */
function requestOf(name: string, tool: Record<string, unknown>, cwd: string | null): ApprovalRequest | null {
  switch (name) {
    case "Bash": {
      const command = text(tool["command"]);
      return command === null ? null : { command, description: text(tool["description"]) };
    }
    case "Write": {
      const path = text(tool["file_path"]);
      if (path === null || typeof tool["content"] !== "string") return null;
      const { shown, card } = paths(path, cwd);
      return { command: tool["content"], description: card, subject: shown };
    }
    case "Edit": {
      const path = text(tool["file_path"]);
      const [from, to] = [tool["old_string"], tool["new_string"]];
      if (path === null || typeof from !== "string" || typeof to !== "string") return null;
      const { shown, card } = paths(path, cwd);
      const diff = [...marked("-", from), ...marked("+", to)].join("\n");
      if (diff === "") return null;
      return { command: diff, description: tool["replace_all"] === true ? `${card} (every match)` : card, subject: shown };
    }
    case "WebFetch": {
      const url = text(tool["url"]);
      const prompt = text(tool["prompt"]);
      return url === null || prompt === null ? null : { command: `url: ${url}\nprompt: ${prompt}`, description: null };
    }
    default: {
      if (!/^mcp__.+/.test(name)) return null;
      const args = Object.entries(tool).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
      return { command: args === "" ? "{}" : args, description: name };
    }
  }
}
