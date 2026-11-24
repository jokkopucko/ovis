import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { runVersion, VERSION_TIMEOUT_MS } from "../agent-catalog-detect.ts";
import type { HarnessCommand } from "./harnesses.ts";

/** The name Ovis gives its own MCP server in a child, which the Claude recipe's ask rule names. */
export const AGENT_MCP_SERVER = "ovis-agent";
const CLAUDE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch"];
export const OPEN_REVIEW = "opencode/all-tools-ask/v1";
export const CLAUDE_REVIEW = "claude/all-tools-ask/v1";
export const CODEX_REVIEW = "codex/read-only-own-rules/v1";
export const COPILOT_REVIEW = "copilot/agent-own-rules/v1";
export const AGY_REVIEW = "agy/strict-own-rules/v1";
/** agy's strictest settings for one run, over the person's own file: every write, command, URL, read and MCP call asked. */
const AGY_SETTINGS = { trustedWorkspaces: [], agentMode: "", toolPermission: "strict", enableTerminalSandbox: false, allowNonWorkspaceAccess: false,
  permissions: { ask: ["write_file(*)", "command(*)", "read_url(*)", "mcp(*)", "read_file(*)", "execute_url(*)", "download_url(*)"], allow: [], deny: [] } };

export type Verified = HarnessCommand & {
  ceiling: { profile: string; mode: string };
  /** the keeper keeps only one-time choices on the child's cards */
  askEveryTime?: boolean;
  /** `_meta` and `configOptions` of the child's `session/new` */
  sessionMeta?: unknown;
  configOptions?: readonly unknown[];
  /** environment variables naming a file in the child's private keeper folder */
  privateFiles?: Record<string, string>;
};

interface AskRecipe {
  profile: string;
  /** the program whose `--version` answer must be one this recipe was run against */
  versioned: (command: HarnessCommand) => string | undefined;
  versions: RegExp;
  /** a reason this PC's own setup could answer for the person, which the launch cannot override */
  blocked?: () => string | null;
  /** the allow rules a person set in the harness itself (theirs or a project folder's) still apply: no launch turns them off */
  ownRules?: true;
  launch: (command: HarnessCommand, runId: string) => Omit<Verified, "ceiling" | keyof HarnessCommand> & { mode: string; env?: Record<string, string>; argv?: readonly string[] };
}

/** Where Claude Code finds a managed policy on Linux and macOS: the system folder's files, the managed-preferences
 * domain an MDM profile installs (for the machine or this user), and the cache of a policy a claude.ai organization
 * sent. A policy an organization sends for the first time during the child's own start is not seen here. */
export const claudeManagedPaths = (): string[] => [
  ...["/etc/claude-code", "/Library/Application Support/ClaudeCode"].flatMap(dir => ["managed-settings.json", "managed-settings.d", "managed-mcp.json"].map(name => join(dir, name))),
  "/Library/Managed Preferences/com.anthropic.claudecode.plist", join("/Library/Managed Preferences", userInfo().username, "com.anthropic.claudecode.plist"),
  join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "remote-settings.json"),
];
/** Managed settings outrank every setting a launch can pass, and their rules and hooks may answer for the person. */
export const claudeManagedPolicy = (paths: readonly string[] = claudeManagedPaths()): string | null =>
  paths.some(path => existsSync(path)) ? "A managed Claude Code policy on this PC could answer for the person." : null;

/**
 * Launches whose every write, side-effecting command, web request and MCP call was seen to reach the
 * ACP client as a permission request, with the user's and the project's own approvals in place
 * (docs/harness-tool.md). An `ownRules` launch is the harness's narrowest asking one: there, only the
 * allow rules the person set in that harness let an action through unasked. Only the versions those
 * runs used are accepted.
 */
const ASK_RECIPES: Record<string, AskRecipe> = {
  opencode: {
    profile: OPEN_REVIEW,
    versioned: command => command.argv[0],
    versions: /^(?:opencode v?)?2\.2\.2$/,
    launch: (_command, runId) => {
      const mode = `ovis-ask-${runId}`;
      const permissions = [{ action: "*", resource: "*", effect: "ask" }];
      return {
        mode,
        privateFiles: { OPENCODE_DB: "opencode.db" },
        env: {
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: mode, permissions, agents: { [mode]: { mode: "primary", permissions } } }),
        },
      };
    },
  },
  claude: {
    profile: CLAUDE_REVIEW,
    versioned: command => command.env?.["CLAUDE_CODE_EXECUTABLE"],
    versions: /^2\.1\.330 \(Claude Code\)$/,
    blocked: () => claudeManagedPolicy(),
    // The adapter starts in `auto` and reads `permissions.defaultMode` itself, past `settingSources`:
    // the mode option is applied before `session/new` answers, so no other mode runs first.
    launch: command => ({
      mode: "default",
      // the config folder whose managed policy was looked for is the one the child reads, whatever herdr-core's environment holds
      ...(process.env["CLAUDE_CONFIG_DIR"] ? { env: { CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] } } : { argv: ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", ...command.argv] }),
      configOptions: [{ configId: "mode", value: "default" }],
      sessionMeta: { claudeCode: { options: {
        settingSources: [],
        allowDangerouslySkipPermissions: false,
        // only the built-in tools the runs covered: EnterWorktree, for one, makes a worktree in default mode unasked
        tools: CLAUDE_TOOLS,
        settings: {
          disableAllHooks: true,
          permissions: { defaultMode: "default", ask: ["Write", "Edit", "Bash", "WebFetch", "WebSearch", `mcp__${AGENT_MCP_SERVER}`] },
          sandbox: { autoAllowBashIfSandboxed: false },
        },
      } } },
    }),
  },
  codex: {
    profile: CODEX_REVIEW,
    versioned: command => command.env?.["CODEX_PATH"],
    versions: /^codex-cli 0\.171\.0$/,
    ownRules: true,
    // codex-acp takes no argv: its environment is the only way in. The mode's approval and sandbox go with every
    // turn, over any config layer; `rules/*.rules` allow rules (the person's and the folder's) have no switch here.
    launch: () => ({
      mode: "read-only",
      env: {
        INITIAL_AGENT_MODE: "read-only",
        CODEX_CONFIG: JSON.stringify({ approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "read-only", web_search: "disabled", features: { hooks: false } }),
      },
    }),
  },
  copilot: {
    profile: COPILOT_REVIEW,
    versioned: command => command.argv[0],
    versions: /^GitHub Copilot CLI 1\.0\.109\.(?:\n|$)/,
    ownRules: true,
    // Its `agent` mode asks for each write, command, fetch and MCP call; nothing here grants more. A `preToolUse` hook
    // of the person's or the folder's (`.github/hooks`) still answers for them. It starts no stdio MCP server from
    // `session/new`, so the child has no ovis-agent MCP tool (the `ovis agent` shell command still reaches Ovis).
    launch: command => ({
      mode: "https://agentclientprotocol.com/protocol/session-modes#agent",
      argv: [...command.argv, "--no-auto-update"],
      env: { COPILOT_ALLOW_ALL: "false" },
    }),
  },
  agy: {
    profile: AGY_REVIEW,
    versioned: command => command.argv[0],
    versions: /^1\.5\.16$/,
    ownRules: true,
    // `--settings` comes before `acp`. A workspace `PreToolUse` hook of the person's still answers for them, and its
    // built-in web search runs unasked whatever the rules say (Settings names both).
    launch: command => ({
      mode: "default",
      argv: [command.argv[0]!, "--settings", JSON.stringify(AGY_SETTINGS), "acp", "--disable-telemetry", "--log-file", "/dev/null", "--include-default-customizations=false"],
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    }),
  },
};
const ASK_PROFILES = new Set(Object.values(ASK_RECIPES).map(recipe => recipe.profile));

export const askable = (kind: string): boolean => Object.hasOwn(ASK_RECIPES, kind);
export const keepsOwnRules = (kind: string): boolean => askable(kind) && ASK_RECIPES[kind]!.ownRules === true;

/** Why this harness cannot get its ask-for-everything launch here: an untested version or a setup it cannot override. */
export async function askRefusal(kind: string, command: HarnessCommand): Promise<string | null> {
  const recipe = Object.hasOwn(ASK_RECIPES, kind) ? ASK_RECIPES[kind]! : null;
  if (!recipe) return "This harness has no verified ask-for-everything launch.";
  const blocked = recipe.blocked?.();
  if (blocked) return blocked;
  const bin = recipe.versioned(command);
  const probe = bin ? await runVersion(bin, ["--version"], VERSION_TIMEOUT_MS) : null;
  return probe && probe.exitCode === 0 && recipe.versions.test(probe.stdout.trim()) ? null : "This version has no verified ask-for-everything launch.";
}

/** Never infer permissions from an adapter's mode name. For an unverified parent only a recipe
 * from ASK_RECIPES may launch, and it must report the recipe's mode over ACP. */
export function permissionLaunch(kind: string, parent: string | undefined, runId: string, command: HarnessCommand): Verified | null {
  if (parent && command.ceiling?.profile === parent) return { ...command, ceiling: command.ceiling };
  const recipe = Object.hasOwn(ASK_RECIPES, kind) ? ASK_RECIPES[kind]! : null;
  if (!recipe || (parent !== undefined && !ASK_PROFILES.has(parent))) return null;
  const { mode, env, ...rest } = recipe.launch(command, runId);
  return { ...command, ...rest, askEveryTime: true, ceiling: { profile: recipe.profile, mode }, env: { ...command.env, ...env } };
}
