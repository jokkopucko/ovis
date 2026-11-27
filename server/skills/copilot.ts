import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { createWalkBudget, environValue, parseJsonc, plainObject, readConfigText, walkSkills } from "./walk.ts";

/**
 * GitHub Copilot CLI 1.0.105: the rows of its own `/` menu, scrolled through in an isolated
 * COPILOT_HOME, with the descriptions `copilot help commands` prints. `/rewind`, `/footer` and
 * `/rubber-duck` are in that help but not in the menu (the menu lists `/undo` for the first).
 */
const descriptions = {
  init: "Initialize Copilot instructions for this repository", agent: "Browse and select agents: /agent [name]",
  skills: "Manage skills for enhanced capabilities", mcp: "Manage MCP server configuration",
  plugin: "Manage plugins and plugin marketplaces",
  model: "Select the AI model for this session (use 'auto' to let Copilot pick automatically)",
  delegate: "Send this session to GitHub and Copilot will create a PR; use --base to choose the PR target branch",
  fleet: "Enable fleet mode for parallel subagent execution",
  autopilot: "Toggle autopilot mode, or set an autopilot objective with an optional AI-credit limit (--max-ai-credits)",
  tasks: "View and manage tasks (subagents and shell commands)", ide: "Connect to an IDE workspace",
  diff: "Review the changes made in the current directory", pr: "Operate on pull requests for the current branch",
  review: "Run code review agent to analyze changes",
  "security-review": "Analyze staged and unstaged changes for security vulnerabilities.",
  "rubber-duck": "Get an independent critique of your current work from the rubber duck agent",
  lsp: "Manage language server configuration", "terminal-setup": "Configure terminal for multiline input support (shift+enter)",
  permissions: "Switch between permission modes", "allow-all": "Enable all permissions (tools, paths, and URLs)",
  sandbox: "Manage sandbox settings, including file path permissions, network permissions, and more",
  "add-dir": "Allow file access to a directory and load its .github skills and agents as trusted configuration",
  "list-dirs": "Display allowed directories and exact session path grants",
  cwd: "Change working directory or show current directory", "reset-allowed-tools": "Reset session tool and exact-path approvals",
  resume: "Switch sessions by local or cloud history ID, task ID, or name",
  rename: "Rename the current session, or auto-generate a name from conversation",
  fork: "Fork the current session into a new session, optionally with a name",
  worktree: "Create a new git worktree from your configured base ref and switch into it",
  move: "Move your uncommitted changes into a new git worktree and switch into it",
  context: "Show context window token usage and visualization", usage: "Display session usage metrics and statistics",
  session: "View and manage sessions. Use subcommands for details.",
  compact: "Summarize conversation history to reduce context window usage. Optionally provide focus instructions.",
  share: "Open sharing actions for this session, or export with file, html, gist, research, or link",
  remote: "Share this session: remote control from GitHub web and mobile, or directly with another CLI",
  copy: "Copy the last response to the clipboard", undo: "Rewind the last turn and revert file changes",
  rewind: "Rewind the last turn and revert file changes", help: "Show help for interactive commands",
  changelog: "Display changelog for CLI versions. Add 'summarize' to get an AI summary.",
  feedback: "Provide feedback about the CLI",
  diagnose: "Analyze session logs, including why a permission request needed approval",
  theme: "View or set color mode", statusline: "Configure status line items", footer: "Configure status line items",
  update: "Update the CLI to the latest version", version: "Display version information and check for updates",
  experimental: "Show available experimental features, or enable/disable experimental mode",
  memory: "Show memory status, or enable/disable memory across sessions", clear: "Abandon this session and start fresh",
  instructions: "View and toggle custom instruction files", app: "Prefer a visual workspace? Try out the GitHub Copilot desktop app",
  ask: "Ask a side question or reopen a recently cached answer without adding to history",
  chronicle: "Session history tools and insights",
  "collect-debug-logs": "Collect debug logs to a local .tgz file, share with GitHub after consent, or create a secret GitHub gist",
  computer: "Show or toggle Computer Use",
  env: "Show loaded environment details (instructions, MCP servers, skills, agents, hooks, plugins, LSPs, extensions)",
  exit: "Exit the CLI; use 'print' to print the session after exiting alt screen",
  "keep-alive": "Manage keep-alive mode (prevents system sleep).",
  limits: "View or edit session limits; the AI Credit limit is a soft cap", login: "Log in to Copilot",
  logout: "Log out of an OAuth login session", new: "Start a new conversation",
  plan: "Create an implementation plan before coding",
  refine: "Rewrite a rough, stream-of-consciousness prompt into a clear one for review",
  research: "Run deep research investigation using GitHub search and web sources",
  restart: "Restart the CLI, restoring supported live sessions in this process",
  search: "Search the conversation timeline (experimental)",
  settings: "Open the settings UI, show, set, or unset a single value",
  subagents: "Configure default and per-agent subagent models", user: "Manage signed-in accounts",
  vim: "Toggle Vim mode for the input", voice: "Manage voice mode (dictation transcription via Foundry Local)",
} as const;
const agentHidden = ["rewind", "footer", "rubber-duck"] as const;

/**
 * Sent bare on 1.0.105, these left a picker, panel, form or pager waiting for a key (checked
 * 2026-11-06); `/login`, `/logout` and `/update` sign in, sign out or install, so they are kept
 * in the terminal from their definition. Given a value (`/model gpt-5`, `/theme dark`) they may
 * just act, which was not recorded.
 */
const terminalBare = [
  "help", "agent", "skills", "mcp", "plugin", "model", "tasks", "ide", "diff", "permissions", "sandbox", "resume",
  "session", "share", "feedback", "theme", "statusline", "footer", "instructions", "chronicle", "limits", "search",
  "settings", "subagents", "voice", "login", "logout", "update",
] as const;
const forms: Record<string, CommandForm[]> = Object.fromEntries(terminalBare.map((name) => [
  name, [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }],
]));

const typedOnly: ReadonlySet<string> = new Set(Object.keys(descriptions));
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * The folders Copilot reads project skills from, nearest first: up to the repository root inside a
 * repository; outside one, up to the home folder (included) or the filesystem root (1.0.105).
 */
function projectFolders(cwd: string, home: string): string[] {
  const folders: string[] = [];
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    folders.push(directory);
    if (existsSync(join(directory, ".git")) || directory === resolve(home) || directory === dirname(directory)) break;
  }
  return folders;
}

export const source: AgentCommandSource = {
  builtins: Object.keys(descriptions).filter((name) => !(agentHidden as readonly string[]).includes(name)),
  chatPaletteHidden: ["allow-all", "autopilot", "plan"],
  descriptions,
  pin: "1.0.105",
  agentHidden,
  forms,
  discover({ home, cwd, env }) {
    const copilotHome = environValue(env, "COPILOT_HOME") || join(home, ".copilot");
    let settings: Record<string, unknown> = {};
    try { settings = plainObject(parseJsonc(readConfigText(join(copilotHome, "settings.json")))); }
    catch {}
    const disabled = new Set(strings(settings.disabledSkills));
    // a relative folder is the Copilot process's, which works in the pane's folder
    const added = strings(settings.skillDirectories).flatMap((path) =>
      path.startsWith("~/") ? [join(home, path.slice(2))] : isAbsolute(path) ? [path] : cwd ? [resolve(cwd, path)] : []);
    // Copilot's order, the first skill of a name winning: the project folders, then the personal
    // folders, then the folders `copilot skill add` saved
    const roots: [string, SlashCommand["origin"]][] = [
      ...(cwd ? projectFolders(cwd, home) : []).flatMap((directory): [string, SlashCommand["origin"]][] =>
        [".github", ".agents", ".claude"].map((prefix) => [join(directory, prefix, "skills"), "project"])),
      [join(copilotHome, "skills"), "user"], [join(home, ".agents", "skills"), "user"],
      ...added.map((path): [string, SlashCommand["origin"]] => [path, "user"]),
    ];
    const budget = createWalkBudget();
    const found = new Map<string, SlashCommand | null>();
    for (const [root, origin] of roots) {
      // a root that is a file is passed over, as Copilot does, rather than ending the whole list
      if (!isDirectory(root)) continue;
      for (const skill of walkSkills(root, { depth: "recursive", looseMarkdown: "none", ignoreFiles: false, requireDescription: false, budget })) {
        // a SKILL.md without frontmatter Copilot can read fails to load there
        if (Object.keys(skill.fields).length === 0) continue;
        const named = typeof skill.fields.name === "string" ? skill.fields.name.trim() : "";
        const name = /^\S+$/.test(named) ? named : skill.name;
        if (found.has(name)) continue;
        // its menu leaves out a disabled skill, one only the model may invoke, and one a builtin outranks
        const invocable = skill.fields["user-invocable"] !== false && skill.fields["user-invocable"] !== "false";
        const listed = invocable && !disabled.has(name) && !typedOnly.has(name);
        found.set(name, listed ? { name, description: skill.description, source: "skill", origin, id: skill.id } : null);
      }
    }
    return [...found.values()].filter((command): command is SlashCommand => command !== null);
  },
};
