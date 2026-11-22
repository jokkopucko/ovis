import { basename, dirname, join, resolve } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { readFileSync, realpathSync } from "node:fs";
import { ancestorsToRepoRoot, createWalkBudget, customCommands, environValue, plainObject, walkSkills } from "./walk.ts";
import type { WalkBudget } from "./walk.ts";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";

/**
 * Claude Code 2.1.301, names from the commands reference (https://code.claude.com/docs/en/commands):
 * every row of its table except the ones it marks removed (pr-comments, vim, ultraplan). Bundled skills
 * and workflows are in the table, so they are offered as builtins too. --add-dir and lazily activated
 * descendant .claude/skills are not observable here.
 * Terminal rows are the commands Chat cannot see through. Sent bare in an isolated 2.1.306 session
 * (2026-10-22), these left a panel, picker, form or prompt on the screen until Esc: the Settings
 * tabs behind cost, usage, stats and status, help, memory, sandbox, tasks and the rest down to
 * passes; add-dir and cd still ask to confirm a path given with them. The account, cloud and setup
 * flows a signed-out session cannot open render the same kind of screen in their own definition.
 * The last group answers only on the PC itself: diff's side panel, ide, copy's clipboard, voice,
 * keybindings' editor, stickers and radio.
 */
export const terminalBound = [
  "config", "hooks", "permissions", "plugin", "resume", "skills", "theme",
  "cost", "usage", "stats", "status", "help", "memory", "sandbox", "tasks", "workflows", "powerup", "scroll-speed", "mobile", "passes",
  "add-dir", "cd", "mcp",
  "artifacts", "auto-mode-setup", "autofix-pr", "bug", "chrome", "design-login", "desktop", "feedback", "import", "install-github-app",
  "install-slack-app", "login", "logout", "privacy-settings", "rate-limit-options", "remote-control", "remote-env", "skill-doctor",
  "teleport", "terminal-setup", "ultrareview", "upgrade", "usage-credits", "web-setup",
  "diff", "ide", "copy", "voice", "keybindings", "stickers", "radio",
] as const;

/** The reference's menu section: these four are typed in full and never shown in the `/` menu. */
const agentHidden = ["agents", "heapdump", "setup-bedrock", "setup-vertex"] as const;

const REFERENCE: readonly string[] = [
    "add-dir", "advisor", "agents", "artifact-capabilities", "artifact-diagramming", "artifacts", "auto-mode-setup",
    "autocompact", "autofix-pr", "background", "batch", "branch", "btw", "bug", "cd", "chrome", "claude-api",
    "claude-in-chrome", "clear", "code-review", "color", "compact", "config", "context", "copy", "cost", "dataviz",
    "debug", "deep-research", "design", "design-login", "design-sync", "desktop", "diff", "doctor", "effort", "exit",
    "export", "fast", "feedback", "fewer-permission-prompts", "focus", "fork", "goal", "heapdump", "help", "hooks",
    "ide", "import", "init", "insights", "install-github-app", "install-slack-app", "keybindings", "list-agents",
    "login", "logout", "loop", "mcp", "memory", "mobile", "model", "output-style", "passes", "permissions", "plan",
    "plugin", "plugin-authoring", "powerup", "privacy-settings", "radio", "rate-limit-options", "recap",
    "release-notes", "reload-plugins", "reload-skills", "remote-control", "remote-env", "rename", "resume",
    "review", "rewind", "run", "run-skill-generator", "sandbox", "schedule", "scroll-speed", "security-review",
    "setup-bedrock", "setup-vertex", "simplify", "skill-doctor", "skills", "slides", "stats", "status", "statusline",
    "stickers", "stop", "subtask", "tasks", "team-onboarding", "teleport", "terminal-setup", "theme", "tui",
    "ultrareview", "update-config", "upgrade", "usage", "usage-credits", "verify", "voice", "web-setup",
    "workflow-authoring", "workflows",
  ];
/**
 * The rows the reference marks Skill or Workflow: prompts handed to Claude, hidden by a `skillOverrides` entry of "off".
 * plugin-authoring is not one: it comes from a built-in plugin, which skillOverrides never touches, so it stays a static builtin.
 * discover returns them as builtin-source rows (not in `builtins`) so that entry can hide them; a skill of the same name replaces one.
 */
const BUNDLED: ReadonlySet<string> = new Set([
  "artifact-capabilities", "artifact-diagramming", "batch", "claude-api", "claude-in-chrome", "code-review", "dataviz", "debug",
  "deep-research", "design", "design-sync", "doctor", "fewer-permission-prompts", "loop", "run",
  "run-skill-generator", "schedule", "simplify", "slides", "update-config", "verify", "workflow-authoring",
]);

/** Claude's own commands, without the bundled skills: an echo of one of these is a command, not a skill. */
export const claudeCommandNames = (): string[] => REFERENCE.filter((name) => !BUNDLED.has(name));

const IGNORED = /[\s\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Skills docs, "When a synced skill name matches another command": "When it compares names, Claude Code ignores
 * case, spacing, and invisible characters, and treats compatibility forms such as fullwidth letters and dash
 * variants as their plain equivalents." Dash variants are the Unicode dash class plus the minus sign; invisible characters are the Unicode default-ignorable code points.
 * Ignorables go first and last (one between a letter and its combining mark would otherwise stop NFKC composing them), and the pass repeats until the key stops changing, so the key is a fixed point.
 */
/**
 * Case folding the way Unicode does it: upper then lower case maps the full-folding pairs together (ß and SS, the Cyrillic and
 * Greek letters with their own lowercase forms), and a final sigma is folded to σ. The dotless ı has no common folding, so it
 * is kept apart from i rather than collapsed into a false collision.
 */
const foldCase = (text: string): string =>
  text.split("\u0131").map((part) => part.toUpperCase().toLowerCase().replaceAll("\u03C2", "\u03C3")).join("\u0131");

const comparePass = (name: string): string =>
  foldCase(name.replace(IGNORED, "").normalize("NFKC")).replace(/[\p{Pd}\u2212]/gu, "-").normalize("NFKC").replace(IGNORED, "");

/** One pass can leave work for the next (NFKC of a spacing accent yields a space, and removing it frees a mark to compose), so repeat until the key stops changing. */
export function comparableName(name: string): string {
  let key = name;
  for (let pass = 0; pass < 4; pass++) {
    const next = comparePass(key);
    if (next === key) break;
    key = next;
  }
  return key;
}

const PIN = "2.1.301";
/** `/review` is the reference's alias of `/code-review`, so both are typed the same way. */
const reviewForms: CommandForm[] = [{ match: "bare", interaction: "unknown" }];
const forms: Record<string, CommandForm[]> = {
  model: [{ match: "bare", interaction: "dialog", dialog: "claude-model" }, { match: "other", interaction: "none" }],
  effort: [{ match: "bare", interaction: "dialog", dialog: "claude-effort" }, { match: "other", interaction: "none" }],
  goal: [{ match: "bare", interaction: "dialog", dialog: "claude-goal" }, { match: { sub: "clear" }, interaction: "none" }, { match: "other", interaction: "none" }],
  btw: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  rewind: [{ match: "bare", interaction: "terminal" }],
  // bare opens a picker; given a value they set it and return
  fast: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  autocompact: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  advisor: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  export: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  // `/plan open` opens the plan in the PC's editor
  plan: [{ match: "bare", interaction: "unknown" }, { match: { sub: "open" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  "code-review": reviewForms,
  review: reviewForms,
};

/** Skills docs: boolean frontmatter takes yes, no, on, off, 1 and 0 in any letter case. */
function isOff(value: unknown): boolean {
  return value === false || value === 0 || (typeof value === "string" && ["false", "no", "off", "0"].includes(value.trim().toLowerCase()));
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Skills docs, "Names reserved for synced skills": `anthropic-skills` and its namespace never load outside a plugin. */
function reservedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "anthropic-skills" || lower.startsWith("anthropic-skills:");
}

/** Skills docs: `synced` holds the claude.ai skills, in any capitalization, so a skill folder of that name is skipped. */
const notSynced = (directory: string): boolean => directory.toLowerCase() === "synced";

function claudeSkills(root: string, origin: SlashCommand["origin"], budget: WalkBudget, prefix?: string): SlashCommand[] {
  return walkSkills(root, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: false, skipNames: origin === "plugin" ? undefined : notSynced, budget })
    .filter(({ fields }) => !isOff(fields["user-invocable"]))
    // the folder name is reserved whatever the frontmatter `name` says (a plugin's names are namespaced)
    .filter(({ path }) => origin === "plugin" || !reservedName(basename(dirname(path))))
    .map(({ name, description, path }) => ({ name: prefix ? `${prefix}:${name}` : name, description, source: "skill", origin, id: canonical(path) }));
}

/** A command file's name is its path under the root with `/` as `:`, so the path follows from the name. */
function claudeCommands(root: string, source: SlashCommand["source"], budget: WalkBudget, prefix?: string): SlashCommand[] {
  // Command files take the same visibility metadata as skills, checked from the original read.
  return customCommands(root, source, budget, (fields) => !isOff(fields["user-invocable"]))
    .map((command) => ({ command, path: join(root, `${command.name.split(":").join("/")}.md`) }))
    .map(({ command, path }) => ({ ...command, id: canonical(path), name: prefix ? `${prefix}:${command.name}` : command.name }));
}

/**
 * `skillOverrides` from settings, lowest scope first so a later scope wins: user, project, local, managed.
 * "off" hides a skill from the `/` menu; the other three states still list it.
 */
function skillOverrides(config: string, ancestors: readonly string[], managed: string): Map<string, string> {
  const read = (path: string): Record<string, unknown> => { try { return plainObject(plainObject(JSON.parse(readFileSync(path, "utf8"))).skillOverrides); } catch { return {}; } };
  const near = [...ancestors].reverse();
  const files = [
    join(config, "settings.json"),
    ...near.map((directory) => join(directory, ".claude", "settings.json")),
    ...near.map((directory) => join(directory, ".claude", "settings.local.json")),
    join(managed, "managed-settings.json"),
  ];
  const result = new Map<string, string>();
  for (const file of files) for (const [name, state] of Object.entries(read(file))) if (typeof state === "string") result.set(name, state);
  return result;
}

/** A linked worktree points into <main>/.git/worktrees/<name>, never a sibling checkout. */
function mainCheckout(repo: string): string | null {
  try {
    const gitdir = readFileSync(join(repo, ".git"), "utf8").match(/^gitdir:\s*(.+)\s*$/)?.[1];
    if (!gitdir) return null;
    const directory = resolve(repo, gitdir.trim());
    const common = readFileSync(join(directory, "commondir"), "utf8").trim();
    return common ? dirname(resolve(directory, common)) : null;
  } catch { return null; /* not a linked worktree */ }
}

function managedSettingsDir(serverEnv: Readonly<Record<string, string | undefined>>): string {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (process.platform === "win32") return join(serverEnv["ProgramFiles"] ?? "C:\\Program Files", "ClaudeCode");
  return "/etc/claude-code";
}

/**
 * The skills and commands of the Claude plugins turned on in settings.json, as Claude
 * offers them: `/<plugin>:<name>`.
 */
function pluginCommands(config: string, budget: WalkBudget): SlashCommand[] {
  const read = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const enabled = (read(join(config, "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const installed = (read(join(config, "plugins", "installed_plugins.json")) as { plugins?: Record<string, Array<{ installPath?: unknown }>> } | null)?.plugins ?? {};
  const result: SlashCommand[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installPath = installed[id]?.[0]?.installPath;
    if (typeof installPath !== "string") continue;
    const plugin = id.split("@")[0]!;
    result.push(...claudeSkills(join(installPath, "skills"), "plugin", budget, plugin));
    result.push(...claudeCommands(join(installPath, "commands"), "plugin", budget, plugin));
  }
  return result;
}


export const source: AgentCommandSource = {
  builtins: REFERENCE.filter((name) => !BUNDLED.has(name)),
  forms,
  terminalBound,
  agentHidden,
  pin: PIN,
  // Skills docs, "Resolve skills that share a name": a skill replaces a built-in command of the same name in a local session.
  skillsOverrideBuiltins: true,
  descriptions: {
    "add-dir": "Add a new working directory", advisor: "Let Claude consult a stronger model",
    artifacts: "Browse published and shared artifacts", "auto-mode-setup": "Teach auto mode about your environment",
    autocompact: "Set how full context gets before summarizing", "autofix-pr": "Monitor and autofix issues with the current pull request",
    background: "Send this session to the background", branch: "Branch the current conversation",
    btw: "Ask a side question without interrupting the current work", bug: "Report a bug or share your conversation",
    cd: "Move this session to a new working directory", chrome: "Open Claude in Chrome settings",
    color: "Set the prompt bar color", context: "Show current context usage",
    doctor: "Health-check your Claude Code setup and fix issues", init: "Initialize a new CLAUDE.md file with codebase documentation",
    insights: "Generate a report analyzing your Claude Code sessions", "security-review": "Complete a security review of the pending changes",
    statusline: "Set up Claude Code's status line UI", "team-onboarding": "Help teammates ramp on Claude Code with a guide from your usage",
    copy: "Copy a response to the clipboard", "design-login": "Authorize design-system access",
    export: "Export the conversation to a file or clipboard", fast: "Toggle fast mode",
    feedback: "Send feedback or report a bug", focus: "Toggle the focused conversation view",
    fork: "Copy this conversation into a background session", ide: "Manage IDE integrations",
    import: "Import configuration from another coding agent", "install-github-app": "Set up Claude GitHub Actions",
    "install-slack-app": "Install the Claude Slack app", keybindings: "Open keyboard shortcuts",
    "list-agents": "List subagents, teammates and other sessions", mcp: "Manage MCP servers",
    mobile: "Show a QR code for the mobile app", "output-style": "List or switch output styles",
    passes: "Share a free week of Claude Code", plan: "Enable plan mode or view the session plan",
    powerup: "Discover Claude Code features through interactive lessons", "privacy-settings": "View and update privacy settings",
    radio: "Listen to Claude FM radio", "rate-limit-options": "Manage usage limits and upgrade options",
    recap: "Generate a one-line session recap", "reload-plugins": "Activate pending plugin changes",
    "reload-skills": "Reload skills added or changed on disk", "remote-control": "Control this session from your phone or browser",
    "remote-env": "Choose the default cloud environment", rename: "Rename the current conversation",
    rewind: "Restore code or conversation to an earlier point", sandbox: "Configure sandboxing",
    "skill-doctor": "Show unused skills that cost context", stickers: "Order Claude Code stickers",
    subtask: "Send a subagent off with the full context", tasks: "View and manage background work",
    teleport: "Send this session to the cloud or resume a cloud session", tui: "Set the terminal UI renderer",
    ultrareview: "Start a cloud agent that finds and verifies bugs", upgrade: "Upgrade your plan",
    usage: "Show session cost, plan usage and activity", "usage-credits": "Configure or request usage credits",
    agents: "Print a reminder to ask Claude to manage subagents",
    "artifact-capabilities": "Load the reference for what a published artifact can use", "artifact-diagramming": "Load diagramming guidance for artifacts",
    batch: "Orchestrate large-scale changes across a codebase in parallel", "claude-api": "Load Claude API and Managed Agents reference material",
    "claude-in-chrome": "Have Claude carry out a task in your browser", "code-review": "Review the current diff or a pull request for bugs",
    review: "Alias of /code-review: review the current diff or a pull request", config: "Open the Settings interface",
    cost: "Alias of /usage", dataviz: "Design guidance for charts, graphs and dashboards", debug: "Enable debug logging and troubleshoot issues",
    "deep-research": "Fan out web searches and synthesize a cited report", design: "Draft UI mockups and screen flows as artboards",
    "design-sync": "Upload your React design system to Claude Design", desktop: "Continue the session in the Claude Code Desktop app",
    "fewer-permission-prompts": "Add an allowlist for common read-only commands", heapdump: "Write a heap snapshot and memory breakdown",
    hooks: "View hook configurations", loop: "Run a prompt repeatedly while the session stays open", permissions: "Manage allow, ask and deny rules",
    plugin: "Manage Claude Code plugins", "plugin-authoring": "Load the reference for writing a mod", resume: "Resume a conversation by ID or name",
    run: "Launch and drive your app to see a change working", "run-skill-generator": "Teach /run and /verify how to launch your app",
    schedule: "Create, update, list or run routines", "scroll-speed": "Adjust mouse wheel scroll speed", "setup-bedrock": "Configure Amazon Bedrock authentication",
    "setup-vertex": "Configure Google Cloud's Agent Platform authentication", simplify: "Review changed code for cleanup and apply fixes",
    skills: "List available skills", slides: "Make a presentation as a Claude Slides artifact", stats: "Alias of /usage, opened on the Stats tab",
    stop: "Stop the background session you are attached to", theme: "Change the color theme", "update-config": "Describe a settings change and Claude edits settings.json",
    verify: "Confirm a code change works by running your app", "workflow-authoring": "Load the reference for writing workflow scripts",
    voice: "Toggle voice mode", "web-setup": "Set up cloud sessions with GitHub", workflows: "Browse workflows",
  },
  discover({ home, cwd, env, version, serverEnv = process.env }) {
    const budget = createWalkBudget();
    const managed = managedSettingsDir(serverEnv);
    const config = environValue(env, "CLAUDE_CONFIG_DIR") || join(home, ".claude");
    const ancestors = cwd ? ancestorsToRepoRoot(cwd, home) : [];
    const projectSkills = ancestors.flatMap((directory) => claudeSkills(join(directory, ".claude", "skills"), "project", budget));
    const repo = ancestors.at(-1);
    if (repo && projectSkills.length === 0) {
      const main = mainCheckout(repo);
      if (main) projectSkills.push(...claudeSkills(join(main, ".claude", "skills"), "project", budget));
    }
    const overrides = skillOverrides(config, ancestors, managed);
    const shown = ({ name }: SlashCommand): boolean => !reservedName(name);
    const visible = (command: SlashCommand): boolean => shown(command) && overrides.get(command.name) !== "off";
    // Skills beat legacy command files; within each kind enterprise > personal > nearest project.
    // Plugin rows are namespaced, and skillOverrides never applies to them.
    const candidates = [
      ...claudeSkills(join(managed, ".claude", "skills"), "user", budget).filter(visible),
      ...claudeSkills(join(config, "skills"), "user", budget).filter(visible),
      ...projectSkills.filter(visible),
      ...claudeCommands(join(config, "commands"), "user", budget).filter(visible),
      ...ancestors.flatMap((directory) => claudeCommands(join(directory, ".claude", "commands"), "project", budget)).filter(visible),
      ...pluginCommands(config, budget),
    ];
    const local = new Set<string>(candidates.map(({ name }) => name));
    const seen = new Set<string>([...local, ...REFERENCE].map(comparableName));
    // Skills docs, "When a synced skill name matches another command": the short name, or the full
    // `anthropic-skills:<name>` form while another command, builtin or skill has the short one.
    for (const command of claudeSkills(join(config, "skills", "synced"), "user", budget).filter(({ name }) => overrides.get(name) !== "off")) {
      candidates.push(seen.has(comparableName(command.name)) ? { ...command, name: `anthropic-skills:${command.name}` } : command);
      seen.add(comparableName(command.name));
    }
    // A skill of the same name replaces a bundled one (Skills docs, "Resolve skills that share a name").
    const pinned = PIN.split(".").slice(0, 2).join(".");
    const verified = (version ?? "").split(".").slice(0, 2).join(".") === pinned;
    for (const name of BUNDLED) {
      if (overrides.get(name) === "off" || local.has(name)) continue;
      candidates.push({
        name, description: source.descriptions?.[name] ?? `Run /${name}`, source: "builtin", id: name,
        forms: forms[name] ?? [{ match: "bare", interaction: "unknown" }], visibility: "offered", provenance: { transport: "static", verified },
      });
    }
    const unique = new Set<string>();
    return candidates.filter(({ name }) => {
      if (unique.has(name)) return false;
      unique.add(name);
      return true;
    }).map((command) => command.source !== "builtin" && command.origin !== "plugin" && BUNDLED.has(command.name) ? { ...command, shadows: "builtin" as const } : command);
  },
};
