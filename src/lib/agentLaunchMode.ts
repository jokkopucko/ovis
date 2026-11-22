import { hasNoControlCharacters, CLAUDE_EFFORTS, CLAUDE_ULTRACODE_SETTINGS, CODEX_EFFORTS, DSH_EFFORTS, MODEL_NAME } from "../../shared/launch-rules.ts";

export { CLAUDE_EFFORTS, CODEX_EFFORTS };

/** Claude Code's `--permission-mode` choices; "default" leaves the flag out */
export const CLAUDE_LAUNCH_MODES = ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"] as const;
export type ClaudeLaunchMode = (typeof CLAUDE_LAUNCH_MODES)[number];

/** Codex's `/approvals` presets, each a sandbox and an approval policy; "default" leaves both out */
export const CODEX_LAUNCH_MODES = ["default", "readOnly", "auto", "fullAccess"] as const;
export type CodexLaunchMode = (typeof CODEX_LAUNCH_MODES)[number];

const CODEX_ARGS: Record<Exclude<CodexLaunchMode, "default">, string[]> = {
  readOnly: ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
  auto: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
  fullAccess: ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
};

export interface LaunchCapabilities {
  model: boolean;
  efforts: readonly string[];
  /** Claude Code's Ultracode switch goes on the command line as one inline `--settings` object */
  ultracode: boolean;
  /**
   * the first prompt goes on the command line after an end-of-options separator, which the agent's
   * parser verifiably takes as the prompt and never as a subcommand or a flag; otherwise the bridge
   * queues the message for the agent's first ready turn (POST .../create `first_message`)
   */
  positionalPrompt: boolean;
}

const NO_CAPABILITIES: LaunchCapabilities = { model: false, efforts: [], ultracode: false, positionalPrompt: false };

const CAPABILITIES: Readonly<Record<string, LaunchCapabilities>> = {
  // `claude "query"` starts an interactive session with that prompt; `--model` takes an alias (sonnet,
  // opus, haiku) or a full name; `--effort` a level (code.claude.com/docs/en/cli-reference, 2026-10-20).
  // The prompt never goes on its command line: Claude Code's parser (commander) dispatches the first
  // operand to a subcommand of that name even after `--` (commander's parseOptions pushes what follows
  // `--` to the operands, and _parseCommand dispatches operands[0]); verified on claude 2.1.304 in an
  // isolated HOME on 2026-10-20: `claude -- update` ran the updater, while `claude -- --help` and
  // `claude -- '-p x'` were prompts. So a first message for Claude Code is the bridge's pending message.
  // Ultracode is a setting, not a level, since 2.1.284 (shared/launch-rules.ts CLAUDE_EFFORTS). Its key in
  // 2.1.311's settings schema: "Enable ultracode for the session: standing dynamic-workflow orchestration
  // at any effort level. Session-scoped — typically provided via --settings or the apply_flag_settings
  // control request; interactive toggles never persist it." `--settings <file-or-json>` reads a value that
  // starts with `{` and ends with `}` as JSON, adds it over the settings files for this session only, and
  // keeps only the last of two; nothing in Ovis or herdr passes another. Verified on 2.1.311 on 2026-10-28:
  // `claude --effort medium --settings '{"ultracode":true}'` started at medium with Ultracode on, and a
  // model or a configuration without Ultracode ignores the key without an error. On a Windows PC the bridge
  // passes the same object as a settings file's path (server/claude-settings-file.ts).
  claude: { model: true, efforts: CLAUDE_EFFORTS, ultracode: true, positionalPrompt: false },
  // `codex [OPTIONS] [PROMPT]`: "Optional user prompt to start the session" (codex-rs/tui/src/cli.rs);
  // `--model`/`-m` (codex-rs/utils/cli/src/shared_options.rs); `-c model_reasoning_effort=<level>` is
  // a config.toml override on the command line (codex-rs/utils/cli/src/config_override.rs), 2026-10-20.
  // The prompt goes after `--`: clap matches a subcommand only `if !trailing_values`, and `--` sets
  // `trailing_values = true` (clap_builder/src/parser/parser.rs, get_matches_with), so what follows is
  // the PROMPT positional whatever it says; verified on codex 0.163.0 in an isolated CODEX_HOME on
  // 2026-10-20: `codex -- logout`, `-- update`, `-- --help` and `-- '-p x'` all started the TUI, and
  // `codex -- logout extra` failed with the root `[PROMPT]` usage, `codex logout extra` with the subcommand's
  codex: { model: true, efforts: CODEX_EFFORTS, ultracode: false, positionalPrompt: true },
  // dsh-tui 0.20.0 takes no effort flag: the bridge saves `--effort <level>` to ~/.dsh-tui/effort.json, which its
  // `/effort <id>` writes and its boot reads, and types the command without it (server/agent-launch.ts).
  "dsh-tui": { model: false, efforts: DSH_EFFORTS, ultracode: false, positionalPrompt: false },
};

const MODEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ["sonnet", "opus", "haiku"],
};

export function modelSuggestions(kind: string): readonly string[] {
  return Object.hasOwn(MODEL_ALIASES, kind) ? MODEL_ALIASES[kind]! : [];
}

export function launchCapabilities(kind: string): LaunchCapabilities {
  return Object.hasOwn(CAPABILITIES, kind) ? CAPABILITIES[kind]! : NO_CAPABILITIES;
}

export interface LaunchChoices {
  model?: string;
  effort?: string;
  ultracode?: boolean;
  prompt?: string;
}

export function launchChoiceFault(kind: string, choices: LaunchChoices): "model" | "effort" | "ultracode" | "prompt" | null {
  const can = launchCapabilities(kind);
  const model = choices.model?.trim() ?? "";
  if (model !== "" && (!can.model || !MODEL_NAME.test(model))) return "model";
  if (choices.effort && !can.efforts.includes(choices.effort)) return "effort";
  if (choices.ultracode && !can.ultracode) return "ultracode";
  if ((choices.prompt?.trim() ?? "") !== "" && kind === "") return "prompt";
  return null;
}

export function firstPromptDelivery(kind: string, prompt: string | undefined): "positional" | "pending" | null {
  const text = prompt?.trim() ?? "";
  if (text === "" || kind === "") return null;
  return launchCapabilities(kind).positionalPrompt && hasNoControlCharacters(text) ? "positional" : "pending";
}

export interface LaunchDefaultSettings {
  claudeLaunchModel: string;
  claudeLaunchEffort: string;
  codexLaunchModel: string;
  codexLaunchEffort: string;
}

export function launchDefaults(kind: string, settings: LaunchDefaultSettings): { model: string; effort: string } {
  const set = kind === "claude" ? { model: settings.claudeLaunchModel, effort: settings.claudeLaunchEffort }
    : kind === "codex" ? { model: settings.codexLaunchModel, effort: settings.codexLaunchEffort } : null;
  if (set === null) return { model: "", effort: "" };
  const model = set.model.trim();
  return {
    model: launchChoiceFault(kind, { model }) === null ? model : "",
    effort: launchChoiceFault(kind, { effort: set.effort }) === null ? set.effort : "",
  };
}

export function modelDraftAfterSync(kind: string, draft: string, model: string): string {
  return draft.trim() === model || launchChoiceFault(kind, { model: draft }) === "model" ? draft : model;
}

export function launchArgs(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }, choices: LaunchChoices = {}): string[] | undefined {
  const args: string[] = [];
  if (kind === "claude" && modes.claudeLaunchMode !== "default") args.push("--permission-mode", modes.claudeLaunchMode);
  if (kind === "codex" && modes.codexLaunchMode !== "default") args.push(...CODEX_ARGS[modes.codexLaunchMode]);
  const can = launchCapabilities(kind);
  const model = choices.model?.trim() ?? "";
  if (model !== "" && can.model && MODEL_NAME.test(model)) args.push("--model", model);
  if (choices.effort && can.efforts.includes(choices.effort)) {
    args.push(...(kind === "codex" ? ["-c", `model_reasoning_effort=${choices.effort}`] : ["--effort", choices.effort]));
  }
  if (choices.ultracode && can.ultracode) args.push("--settings", CLAUDE_ULTRACODE_SETTINGS);
  // the prompt last, after the end-of-options separator: nothing it says can be a flag or a subcommand there
  if (firstPromptDelivery(kind, choices.prompt) === "positional") args.push("--", choices.prompt!.trim());
  return args.length === 0 ? undefined : args;
}

export function launchAgent(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }, choices: LaunchChoices = {}): { kind: string; args?: string[] } | null {
  if (!kind) return null;
  const args = launchArgs(kind, modes, choices);
  return args === undefined ? { kind } : { kind, args };
}
