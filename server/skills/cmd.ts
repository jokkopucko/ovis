import { join, resolve } from "node:path";
import type { AgentCommandContext, AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, createWalkBudget, customCommandSteps, readSkillText, walkSkillSteps } from "./walk.ts";
import type { WalkBudget } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

const descriptions: Readonly<Record<string, string>> = {
  init: "Initialize AGENTS.md for this project",
  import: "Import your setup (skills, agents, commands, MCP, memory) from another coding agent",
  goal: "Set an objective for the agent to work towards",
  memory: "Manage Command Code memory",
  resume: "Resume a past conversation",
  fork: "Fork the conversation into a new session",
  worktree: "Create, list, or switch isolated git worktrees",
  clone: "Clone the current branch into a new session and switch to it",
  rename: "Rename the current session",
  name: "Alias of /rename; bare /name shows the current name",
  rewind: "Restore to a previous checkpoint (Press Esc twice)",
  tree: "Browse the session tree and jump to any point in it",
  clear: "Start a new session with empty context; previous stays on disk, resumable with /resume",
  theme: "Switch themes; `auto` matches your terminal background",
  language: "Switch the interface language (English / 简体中文)",
  share: "Share as a GitHub gist — link sharing is being rebuilt, use /export",
  unshare: "Stop sharing conversation",
  taste: "Manage Taste learning and usage",
  "learn-taste": "Learn taste from sessions with other coding agents (Claude Code, Cursor, etc)",
  skills: "Browse and open agent skills",
  agents: "Manage agent configurations",
  design: "Design partner: audit, build, compose, and ship UI - type /design to browse modes",
  mcp: "Manage MCP server connections",
  model: "Switch between Command Code models",
  effort: "Set reasoning effort for the current model",
  connect: "Connect to AI providers. Command Code, BYOK providers and API keys",
  compact: "Compact the conversation history",
  "compact-mode": "Select a compact mode to compact sessions",
  config: "Search and change settings, including which model runs each built-in task",
  context: "Show context window usage and breakdown",
  ide: "Connect IDE to share your open file and selected lines",
  "terminal-setup": "Setup VSCode keybindings",
  login: "Log in to Command Code",
  logout: "Log out of Command Code",
  learn: "Open the Command Code learn hub in your browser",
  feedback: "Report a bug or share feedback — opens a prefilled GitHub issue",
  trace: "Copy the current trace id; required for support debugging",
  "session-file": "Show the current session id and path to the on-disk session file",
  copy: "Copy the last response to the clipboard",
  export: "Export session — /export [html|jsonl|md] or a file path",
  changelog: "See what's new in Command Code",
  hotkeys: "Show all keyboard shortcuts",
  todos: "Manage the session todo list — c completes an item, x removes it, a completes all (needs the `todos` mod: `cmd mods enable todos`)",
  loop: "Re-run a task on fixed intervals, or let the agent pace itself",
  rc: "Remote-control this session from Telegram or Discord",
  plan: "Enter plan mode; /plan <task> plans that task",
  mode: "Show or switch the permission mode — /mode [default|accept-edits|plan]",
  "mode:default": "Switch to default mode (prompt before edits/commands)",
  "mode:accept-edits": "Switch to accept edits mode (accept edits automatically)",
  "mode:plan": "Switch to plan mode (read-only, no side effects)",
  plans: "Browse, review, and annotate saved plans",
  "plan-review": "Review this session's latest plan",
  review: "Review a pull request (optional PR number)",
  "pr-comments": "Fetch all PR comments for current branch",
  "add-dir": "Manage additional directory scope",
  status: "Show comprehensive environment status",
  statusline: "Configure Command Code's statusline UI",
  usage: "Display credits, plan, and usage metrics",
  upgrade: "Open billing page to upgrade your plan",
  extra: "Buy extra usage at API cost, zero markup",
  update: "Update Command Code to the latest version",
  reload: "Restart Command Code and resume this session (applies a staged update)",
  mods: "List loaded mods and panes",
  help: "Display help information",
  exit: "Exit Command Code",
};

const aliases = ["new", "sessions", "quit", "issue", "courses"] as const;
const forms: NonNullable<AgentCommandSource["forms"]> = {
  "mode:default": [{ match: "bare", interaction: "none" }],
  "mode:accept-edits": [{ match: "bare", interaction: "none" }],
  "mode:plan": [{ match: "bare", interaction: "none" }],
  "plan-review": [{ match: "bare", interaction: "terminal" }],
  "pr-comments": [{ match: "bare", interaction: "terminal" }],
  // bare opens the add-dir modal, the compact mode or language selector, or the full-screen context view (dist/cli.mjs dispatchCommand)
  "add-dir": [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  agents: [{ match: "bare", interaction: "terminal" }],
  changelog: [{ match: "bare", interaction: "terminal" }, { match: { sub: "all" }, interaction: "terminal" }],
  clear: [{ match: "bare", interaction: "none" }],
  clone: [{ match: "bare", interaction: "unknown" }],
  compact: [{ match: "bare", interaction: "none" }],
  "compact-mode": [{ match: "bare", interaction: "terminal" }],
  context: [{ match: "bare", interaction: "terminal" }],
  config: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  connect: [{ match: "bare", interaction: "terminal" }],
  copy: [{ match: "bare", interaction: "terminal" }],
  design: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  effort: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  exit: [{ match: "bare", interaction: "terminal" }],
  extra: [{ match: "bare", interaction: "terminal" }],
  feedback: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  fork: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "unknown" }],
  goal: [{ match: "bare", interaction: "unknown" }, { match: { sub: "status" }, interaction: "unknown" }, { match: { sub: "clear" }, interaction: "none" }, { match: "other", interaction: "none" }],
  help: [{ match: "bare", interaction: "terminal" }],
  hotkeys: [{ match: "bare", interaction: "terminal" }],
  ide: [{ match: "bare", interaction: "terminal" }],
  import: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "unknown" }],
  init: [{ match: "bare", interaction: "none" }],
  language: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  learn: [{ match: "bare", interaction: "terminal" }],
  "learn-taste": [{ match: "bare", interaction: "terminal" }],
  login: [{ match: "bare", interaction: "terminal" }],
  logout: [{ match: "bare", interaction: "terminal" }],
  loop: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "unknown" }],
  mcp: [{ match: "bare", interaction: "terminal" }],
  memory: [{ match: "bare", interaction: "terminal" }],
  mode: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  model: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  mods: [{ match: "bare", interaction: "terminal" }, { match: { sub: "reload" }, interaction: "unknown" }, { match: { sub: "open" }, interaction: "unknown" }, { match: { sub: "close" }, interaction: "unknown" }],
  name: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "none" }],
  new: [{ match: "bare", interaction: "none" }],
  plan: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }],
  plans: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  quit: [{ match: "bare", interaction: "terminal" }],
  rc: [{ match: "bare", interaction: "terminal" }, { match: { sub: "status" }, interaction: "terminal" }, { match: { sub: "off" }, interaction: "none" }, { match: "other", interaction: "unknown" }],
  reload: [{ match: "bare", interaction: "terminal" }],
  rename: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "none" }],
  resume: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  review: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "unknown" }],
  rewind: [{ match: "bare", interaction: "terminal" }],
  sessions: [{ match: "bare", interaction: "terminal" }],
  share: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  skills: [{ match: "bare", interaction: "terminal" }],
  status: [{ match: "bare", interaction: "terminal" }],
  statusline: [{ match: "bare", interaction: "terminal" }, { match: { sub: "off" }, interaction: "none" }, { match: { sub: "on" }, interaction: "none" }, { match: { sub: "reset" }, interaction: "none" }],
  taste: [{ match: "bare", interaction: "terminal" }],
  "terminal-setup": [{ match: "bare", interaction: "terminal" }],
  theme: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  todos: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  trace: [{ match: "bare", interaction: "terminal" }],
  tree: [{ match: "bare", interaction: "terminal" }],
  unshare: [{ match: "bare", interaction: "terminal" }],
  update: [{ match: "bare", interaction: "terminal" }],
  upgrade: [{ match: "bare", interaction: "terminal" }],
  usage: [{ match: "bare", interaction: "terminal" }],
  worktree: [{ match: "bare", interaction: "unknown" }, { match: { sub: "list" }, interaction: "terminal" }, { match: { sub: "remove" }, interaction: "unknown" }, { match: "other", interaction: "unknown" }],
};

const builtins = Object.keys(descriptions);
const formsByName = forms;
const bundledSkills = ["agent-browser", "command-code-knowledge", "config", "design", "loop", "mod-builder", "skill-builder"];
const bundledDescriptions: Readonly<Record<string, string>> = {
  "agent-browser": "Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task.",
  "command-code-knowledge": "Authoritative Command Code product knowledge — slash commands, CLI options, permissions, skills, custom agents, MCP servers, hooks, memory, headless mode, plan mode, checkpoints, sessions, the model catalog, custom/BYOK providers, taste, pricing, and troubleshooting.",
  config: "Inspect or change validated Command Code settings. Use when asked about configuration, current values, themes, permission defaults, feature models, taste learning, sharing defaults, or when a setting change would help complete the task.",
  design: "Design partner for frontend interfaces. One command covers every visual discipline: color, typography, layout, motion, interaction, accessibility, responsive behavior, voice, surface, review, and refinement.",
  loop: "Re-run a task on fixed intervals, or let the agent pace itself. Use for polling deploys, watching builds or pull requests.",
  "mod-builder": "Build a Command Code mod (a loadable plugin) end to end — a TypeScript file that registers tools, slash commands, lifecycle hooks, event observers, input interception, custom renderers, flags, or a model provider through the ModApi.",
  "skill-builder": "Author a new Agent Skill for Command Code end to end — scaffold the directory, write valid SKILL.md frontmatter, structure the instructions for progressive disclosure, and verify the skill loads.",
};

const readSettings = (path: string): Record<string, unknown> => {
  try {
    // bounded and regular files only: a FIFO or a link to /dev/zero committed as settings must not block the server
    const value: unknown = JSON.parse(readSkillText(path));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
};
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function* skillsAt(root: string, origin: NonNullable<SlashCommand["origin"]>, disabled: ReadonlySet<string>, budget: WalkBudget): Generator<SlashCommand | null> {
  try {
    for (const skill of walkSkillSteps(root, { depth: "recursive", looseMarkdown: "root", ignoreFiles: false, requireDescription: true, uniqueFolders: true, budget })) {
      if (!skill) { yield null; continue; }
      if (skill.fields["user-invocable"] === false || disabled.has(skill.name)) { yield null; continue; }
      yield { name: skill.name, description: skill.description, source: "skill", origin, id: skill.id };
    }
  } catch { return; }
}

function* commandsAt(root: string, origin: SlashCommand["source"], budget: WalkBudget): Generator<SlashCommand | null> {
  try {
    for (const command of customCommandSteps(root, origin, budget, undefined, true)) {
      if (!command) { yield null; continue; }
      const folder = command.name.includes(":") ? command.name.slice(0, command.name.lastIndexOf(":")).split(":").at(-1) : "";
      yield {
        ...command,
        name: command.name.split(":").at(-1)!,
        description: folder ? `${folder} · ${command.description}` : command.description,
      };
    }
  } catch { return; /* an unreadable command root lists nothing, as Command Code's own loader skips it */ }
}

function discover(ctx: AgentCommandContext): SlashCommand[] {
  const budget = createWalkBudget();
  const { home, cwd } = ctx;
  const agentDir = join(home, ".commandcode");
  const directories = cwd ? ancestorsToRepoRoot(cwd, home) : [];
  const repoRoot = directories.at(-1) ?? cwd ?? home;
  const userSettings = readSettings(join(agentDir, "settings.json"));
  const projectSettingsDir = join(repoRoot, ".commandcode");
  const projectSettings = cwd ? readSettings(join(projectSettingsDir, "settings.json")) : {};
  const projectLocalSettings = cwd ? readSettings(join(projectSettingsDir, "settings.local.json")) : {};
  const disabled = new Set([
    ...stringArray(userSettings.disabledSkills),
    ...stringArray(projectSettings.disabledSkills),
    ...stringArray(projectLocalSettings.disabledSkills),
  ]);
  const projectSkillsConfig = Array.isArray(projectLocalSettings.skills) ? projectLocalSettings.skills : projectSettings.skills;
  const projectDefinesSkills = Array.isArray(projectLocalSettings.skills) || Array.isArray(projectSettings.skills);
  const configured = stringArray(projectDefinesSkills ? projectSkillsConfig : userSettings.skills);
  const extraRoots = new Set(configured.map((path) => resolve(repoRoot, path === "~" || path.startsWith("~/") ? join(home, path.slice(2)) : path)));
  const personalRoots = [
    { path: join(agentDir, "skills"), origin: "user" as const },
    { path: join(home, ".agents", "skills"), origin: "user" as const },
  ];
  // Command Code 1.84.0 createSkillRegistry: project, user, extra, bundled; first name wins.
  const roots = [
    ...directories.flatMap((directory) => [
      { path: join(directory, ".commandcode", "skills"), origin: "project" as const },
      { path: join(directory, ".agents", "skills"), origin: "project" as const },
    ]),
    ...personalRoots,
    ...[...extraRoots].map((path) => ({ path, origin: projectDefinesSkills ? "project" as const : "user" as const })),
  ];
  const commandRoots = [
    { path: join(agentDir, "commands"), origin: "user" as const },
    ...directories.map((directory) => ({ path: join(directory, ".commandcode", "commands"), origin: "project" as const })),
  ];
  const candidates = [
    ...commandRoots.map(({ path, origin }) => ({
      walk: commandsAt(path, origin, budget), command: true, personal: false, rows: new Array<SlashCommand>(), cut: false,
    })),
    ...roots.map((location) => ({
      walk: skillsAt(location.path, location.origin, disabled, budget),
      command: false, personal: personalRoots.some((root) => root === location), rows: new Array<SlashCommand>(), cut: false,
    })),
  ];
  const spent = (): boolean => budget.folders <= 0 || budget.entries <= 0 || budget.reads <= 0;
  const advance = (walks: typeof candidates): typeof candidates => walks.filter((candidate) => {
    const step = candidate.walk.next();
    if (step.done) { candidate.cut = spent(); return false; }
    // Only a command found before the bound was spent is safe: after that the walk may have skipped a
    // folder or entries holding a same-name command that Command Code reaches first.
    if (step.value && !(candidate.command && spent())) candidate.rows.push(step.value);
    return true;
  });
  const reserved = { folders: budget.folders / 2, entries: budget.entries / 2, reads: budget.reads / 2 };
  let personal = candidates.filter((candidate) => candidate.personal);
  while (personal.length && budget.folders >= reserved.folders && budget.entries >= reserved.entries && budget.reads >= reserved.reads) personal = advance(personal);
  let pending = candidates;
  while (pending.length) pending = advance(pending);
  // Once a command root is cut short, any name may be one of its unlisted commands, which Command Code
  // runs first: lower-priority command roots list nothing, and skills keep only their /skill: form.
  let unresolved = false;
  const discovered = candidates.flatMap((candidate, index) => {
    if (index >= commandRoots.length) return candidate.rows;
    const rows = unresolved ? [] : candidate.rows;
    unresolved ||= candidate.cut;
    return rows;
  });
  const shadowed = new Set([...source.builtins, ...discovered.filter((row) => row.source !== "skill").map(({ name }) => name)].map((name) => name.toLocaleLowerCase()));
  const bundled = bundledSkills.filter((name) => !disabled.has(name)).map((name): SlashCommand => ({
    name,
    description: bundledDescriptions[name] ?? name,
    source: "skill",
    origin: "bundled",
    id: `command-code@1.84.0:skill:${name}`,
  }));
  const seen = new Set(source.builtins.map((name) => name.toLocaleLowerCase()));
  return [...discovered, ...bundled].map((row) => row.source === "skill" && (unresolved || shadowed.has(row.name.toLocaleLowerCase())) ? { ...row, name: `skill:${row.name}` } : row).filter((row) => {
    const key = row.name.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const source: AgentCommandSource = {
  builtins: [...builtins, ...aliases],
  chatPaletteHidden: ["mode:accept-edits", "mode:default", "mode:plan", "plan"],
  descriptions: {
    ...descriptions,
    new: descriptions.clear!,
    sessions: descriptions.resume!,
    quit: descriptions.exit!,
    issue: descriptions.feedback!,
    courses: descriptions.learn!,
  },
  forms: {
    ...formsByName,
    new: formsByName.clear!,
    sessions: formsByName.resume!,
    quit: formsByName.exit!,
    issue: formsByName.feedback!,
    courses: formsByName.learn!,
  },
  pin: "1.84.0",
  skillsOverrideBuiltins: false,
  discover,
};
