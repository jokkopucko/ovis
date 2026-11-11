/**
 * What a new agent's launch may carry from the new workspace and tab dialogs (#774, #1311, #2232): a
 * model, an effort level, Claude Code's Ultracode, a first prompt on Codex's command line, and a first
 * message the bridge queues. The dialog (src/lib/agentLaunchMode.ts) and the bridge's create routes
 * (server/agent-launch.ts, server/workspace-routes.ts) check them by these rules, so what the dialog
 * lets through is what the bridge takes; the demo's transport checks only the first message.
 */

/**
 * Claude Code's effort levels, as its `claude --help` lists them: "--effort <level>  Effort level for
 * the current session (low, medium, high, xhigh, max)" (2.1.311). Ultracode is no level: since 2.1.284
 * it is a setting of its own that keeps whichever level the session runs at (code.claude.com/docs/en/
 * model-config, read 2026-10-28), so the dialog offers it as a switch (src/lib/agentLaunchMode.ts).
 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/**
 * What a Claude Code launch may still pass after `--effort`: the levels and `ultracode`, which 2.1.311's
 * parser still takes as xhigh with Ultracode on (its `{ultracode: "xhigh"}` alias table) and the docs
 * still list ("`ultracode` requests `xhigh` effort with ultracode turned on", cli-reference, read
 * 2026-10-28). A launch an older page or another API client builds with it starts as it did.
 */
const CLAUDE_EFFORT_ARGS: readonly string[] = [...CLAUDE_EFFORTS, "ultracode"];
/**
 * `--settings` for a Claude Code session with Ultracode on: "set `"ultracode": true` in a settings
 * file, with `--settings`" (code.claude.com/docs/en/model-config). The key "doesn't change the
 * session's effort level" (code.claude.com/docs/en/settings-reference#ultracode, read 2026-10-28).
 */
export const CLAUDE_ULTRACODE_SETTINGS = '{"ultracode":true}';
/**
 * Codex's `model_reasoning_effort` levels: "such as low, medium, high, xhigh, max, or ultra. Available
 * levels depend on the model and client." (developers.openai.com/codex/config-reference, read 2026-10-20)
 */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * A model name as the CLIs take it after `--model`: one word that never reads as a flag, with an
 * optional bracketed variant such as Claude Code's `[1m]` context window (`opus[1m]`).
 */
export const MODEL_NAME = /^[A-Za-z0-9][\w.:/-]*(?:\[[A-Za-z0-9]+\])?$/;

/** the most a first message (and a queued chat message, server/core/composer.ts pendingText) may hold */
export const MAX_FIRST_MESSAGE_CHARS = 20_000;

/**
 * A message without the line breaks it ends in, read from its end. As a pattern (`/[\r\n]+$/`) this starts over at
 * every line break of a run that does not end the text, which costs the run's length squared: 40,000 line breaks
 * before one letter took 1.4 s, on the server's only thread and before any length was checked.
 */
export function withoutTrailingBreaks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** terminal control characters a queued message may not carry; TAB, LF and CR are text there */
const MESSAGE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
/** every control character, TAB and line breaks included: one argument on a command line is one line */
const ARGUMENT_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Whether `text` can go on an agent's command line as one argument. */
export const argumentText = (text: string): boolean => !ARGUMENT_CONTROLS.test(text);

/** What is wrong with a create request's `first_message`, in the API's words; null when it can be queued (or there is none). */
export function firstMessageFault(value: unknown, agent: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "first_message must be a string";
  if (value.trim() === "" || value.length > MAX_FIRST_MESSAGE_CHARS) return `first_message must contain text and be at most ${MAX_FIRST_MESSAGE_CHARS} characters`;
  if (MESSAGE_CONTROLS.test(value)) return "first_message must not contain terminal control characters";
  if (!agent) return "first_message needs an agent to send it to";
  return null;
}

type LaunchFlag = "model" | "effort" | "config";
/** the flags whose values are checked, by agent: Codex's `-c`/`--config` sets `model` and `model_reasoning_effort` too */
const LAUNCH_FLAGS: Record<"claude" | "codex", Record<string, LaunchFlag>> = {
  claude: { "--model": "model", "--effort": "effort" },
  codex: { "--model": "model", "-m": "model", "--config": "config", "-c": "config" },
};

/**
 * Which checked flag `arg` is, as the CLIs' parsers read it: `--flag value`, `--flag=value`, and for a
 * short flag `-f value`, `-fvalue` or `-f=value`. `value` is undefined when the next argument holds it.
 */
function launchFlag(arg: string, flags: Record<string, LaunchFlag>): { flag: LaunchFlag; value?: string } | null {
  for (const [name, flag] of Object.entries(flags)) {
    if (arg === name) return { flag };
    if (name.startsWith("--") ? arg.startsWith(`${name}=`) : arg.startsWith(name)) {
      const value = arg.slice(name.length);
      return { flag, value: value.startsWith("=") ? value.slice(1) : value };
    }
  }
  return null;
}

/** a TOML string value as Codex's `-c` reads it, `"high"` or `'high'`, or the bare word it falls back to */
const configValue = (value: string): string => {
  const trimmed = value.trim();
  return /^(["']).*\1$/su.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
};

/**
 * What is wrong with an agent's launch arguments, in the API's words; null when they can be passed. No
 * argument may hold a control character. Claude Code's and Codex's model and effort flags take only
 * the values the dialog offers (and Claude Code's `--effort ultracode`), in every spelling their CLIs
 * accept, and Codex's prompt after `--` follows a first message's rules. Any other flag is the agent's
 * own: Ultracode's `--settings {"ultracode":true}` passes as it is.
 */
export function launchArgsFault(kind: string, args: readonly string[]): string | null {
  if (!args.every(argumentText)) return "agent.args must not contain control characters (a tab or a line break included)";
  if (kind !== "claude" && kind !== "codex") return null;
  const efforts: readonly string[] = kind === "claude" ? CLAUDE_EFFORT_ARGS : CODEX_EFFORTS;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") {
      if (kind !== "codex") break;
      const prompt = args.slice(at + 1);
      if (prompt.length !== 1 || firstMessageFault(prompt[0], true) !== null) return "agent.args must end in one prompt after --, nonempty text of at most 20000 characters";
      break;
    }
    const read = launchFlag(arg, LAUNCH_FLAGS[kind]);
    if (read === null) continue;
    // the flag's value is the flag's own, a "--" there included: it is not read again as an argument
    let value = read.value;
    if (value === undefined) { at += 1; value = args[at] ?? ""; }
    let model: string | null = read.flag === "model" ? value : null;
    let effort: string | null = read.flag === "effort" ? value : null;
    if (read.flag === "config") {
      const split = value.indexOf("=");
      const key = split < 0 ? value.trim() : value.slice(0, split).trim();
      const setting = split < 0 ? "" : configValue(value.slice(split + 1));
      if (key === "model") model = setting;
      if (key === "model_reasoning_effort") effort = setting;
    }
    if (model !== null && !MODEL_NAME.test(model)) return "agent.args --model must name one model";
    if (effort !== null && !efforts.includes(effort)) {
      return kind === "claude" ? `agent.args --effort must be one of ${efforts.join(", ")}` : `agent.args model_reasoning_effort must be one of ${efforts.join(", ")}`;
    }
  }
  return null;
}
