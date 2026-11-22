import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { canonicalFile, description, environValue, readFrontmatter, walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

/**
 * Grok 1.0.62 catalog, based on the pinned xai-org/grok-build sources.
 * https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/
 * crates/codegen/xai-grok-pager/src/slash/commands and
 * crates/codegen/xai-grok-shell/src/session/slash_commands.rs
 * (documented at crates/codegen/xai-grok-pager/docs/user-guide/{04-slash-commands,08-skills}.md).
 * We do not run Grok to inspect or verify the documented behavior.
 */
interface GrokCommand {
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly terminal?: true;
  /** Mirrors SlashCommand::visible() == false. */
  readonly hidden?: true;
  /** Mirrors LISTED_IN_COMPLETIONS == cfg!(debug_assertions); false in the pinned release CLI. */
  readonly releaseHidden?: true;
}

// Pager descriptions/aliases come from src/slash/commands at the pinned commit. Shell-only rows
// come from xai-grok-shell/src/session/slash_commands.rs. Pager descriptions win on shared names.
// `voice` computes a platform-specific description; only its stable key-chord text is pinned here.
const GROK_COMMANDS: Readonly<Record<string, GrokCommand>> = {
  tutorial: { description: "Quick tips to get the most out of Grok Build", aliases: ["tour", "onboarding"], terminal: true },
  settings: { description: "Open the settings modal", aliases: ["config", "preferences", "prefs"], terminal: true },
  dashboard: { description: "Open the Agent Dashboard", aliases: ["agents-dashboard", "sessions"], terminal: true },
  workflows: { description: "Browse installed workflows", terminal: true },
  hooks: { description: "View hooks", terminal: true },
  plugins: { description: "View plugins", aliases: ["plugin"], terminal: true },
  marketplace: { description: "View marketplace", terminal: true },
  skills: { description: "View skills", terminal: true },
  btw: { description: "Ask a side question without interrupting", terminal: true },
  voice: { description: "Ctrl+Space/F8; Esc/Enter to stop", terminal: true },
  new: { description: "Start a new session", aliases: ["clear"], terminal: true },
  effort: { description: "Set reasoning effort for the current model", terminal: true },
  "context-window": { description: "Set the context window for the current model", terminal: true },
  model: { description: "Switch the active model", aliases: ["m"], terminal: true },
  context: { description: "View context usage", terminal: true },
  compact: { description: "Compact conversation history", terminal: true },
  fork: { description: "Branch the current session into a peer agent", terminal: true },
  resume: { description: "Resume a previous session", terminal: true },
  loop: { description: "Run a prompt on a recurring interval", terminal: true },
  plan: { description: "Enter plan mode", terminal: true },
  "view-plan": { description: "View the current plan", aliases: ["show-plan", "plan-view"], terminal: true },
  remember: { description: "Save a memory note", terminal: true },
  memory: { description: "Browse, view, and manage your memories", aliases: ["mem"], terminal: true },
  flush: { description: "Save this session's memory to disk now", terminal: true },
  dream: { description: "Consolidate memory now (merge observations into topics)", terminal: true },
  recap: { description: "Summarize the session so far", aliases: ["summarize"], terminal: true },
  rewind: { description: "Rewind to a previous turn", aliases: ["undo"], terminal: true },
  jump: { description: "Jump to a turn in the conversation", terminal: true },
  expand: { description: "Re-print the last collapsed block, fully expanded (minimal mode)", terminal: true },
  "edit-prompt": { description: "Open an external editor for an empty prompt; use the command palette to preserve a draft", terminal: true },
  queue: { description: "List the prompts queued behind the running turn", terminal: true },
  "session-info": { description: "Show session info", aliases: ["status", "info"], terminal: true },
  share: { description: "Share this session via URL", terminal: true },
  rename: { description: "Rename the current session", aliases: ["title"], terminal: true },
  history: { description: "Search prompt history", terminal: true },
  transcript: { description: "View the conversation transcript in your pager ($PAGER)", aliases: ["log"], terminal: true },
  export: { description: "Export the current conversation to a file or clipboard", terminal: true },
  copy: { description: "Copy last response to clipboard or file (/copy [N] [file])", terminal: true },
  find: { description: "Search the conversation scrollback", terminal: true },
  usage: { description: "View usage", aliases: ["cost"], terminal: true },
  tasks: { description: "List background tasks, subagents, and scheduled tasks", terminal: true },
  mcps: { description: "Show MCP server status", terminal: true },
  workflow: { description: "Launch a saved workflow, list runs, or manage a run (pause, resume, stop, save)", terminal: true },
  personas: { description: "Manage personas (create, edit, delete)", terminal: true },
  "config-agents": { description: "Manage agent definitions", aliases: ["agents"], terminal: true },
  theme: { description: "Switch the color theme", aliases: ["t"], terminal: true },
  auto: { description: "Toggle Auto-review (classifier approves safe tools)", terminal: true },
  "always-approve": { description: "Toggle always-approve mode (skip all permission prompts)", aliases: ["yolo"], terminal: true },
  "vim-mode": { description: "Toggle vim-style scrollback keybindings (j/k, h/l, g/G, y/Y, …)", terminal: true },
  multiline: { description: "Toggle multiline input mode (swap Enter and Shift+Enter)", aliases: ["ml"], terminal: true },
  "compact-mode": { description: "Toggle compact UI (less padding, more content)", terminal: true },
  timestamps: { description: "Toggle message timestamps on/off", terminal: true },
  "toggle-mouse-reporting": { description: "Toggle terminal mouse reporting (native click-drag copy/paste)", terminal: true },
  timeline: { description: "Toggle the timeline sidebar", terminal: true },
  cd: { description: "Change the working directory for new agents", terminal: true },
  imagine: { description: "Generate an image from a text description", terminal: true },
  "imagine-video": { description: "Generate a video from a text description", terminal: true },
  docs: { description: "Open How-to Guides or online Build docs", aliases: ["howto", "guides"], terminal: true },
  "release-notes": { description: "View release notes for the current version", aliases: ["changelog"], terminal: true },
  announcements: { description: "Show or hide announcements", terminal: true },
  feedback: { description: "Send feedback about the current session", terminal: true },
  privacy: { description: "Open coding data, retention, and training settings", terminal: true },
  doctor: { description: "Check this session and show available fixes", aliases: ["terminal-setup", "terminal-check", "terminal-info"], terminal: true },
  "import-claude": { description: "Open the Claude settings import modal", terminal: true },
  login: { description: "Log in or re-authenticate with your account", terminal: true },
  logout: { description: "Log out and return to the login screen", terminal: true },
  home: { description: "Return to the welcome screen", aliases: ["welcome"], terminal: true },
  delete: { description: "Delete this session", terminal: true },
  help: { description: "Browse commands and keyboard shortcuts", terminal: true },
  quit: { description: "Quit the application", aliases: ["exit"], terminal: true },
  gboom: { description: "Hidden easter egg", hidden: true },
  debug: { description: "Toggle debug overlays", releaseHidden: true },
  minimal: { description: "Switch this session to minimal (scrollback-native) mode, back with /fullscreen", terminal: true },
  fullscreen: { description: "Switch this session to fullscreen mode, back with /minimal", aliases: ["full"], terminal: true },
  "hooks-trust": { description: "Trust this project for hook execution", hidden: true },
  "hooks-list": { description: "Show hooks loaded in this session", hidden: true },
  "hooks-add": { description: "Add a custom hook file or directory", hidden: true },
  "hooks-remove": { description: "Remove a custom hook file or directory path", hidden: true },
  "hooks-untrust": { description: "Remove trust for the current project", hidden: true },
  "reload-plugins": { description: "Reload plugins from disk (alias for /plugins reload)", hidden: true },
  "deep-research": { description: "Research with bounded parallel agents, cross-check evidence, and write a cited report" },
  goal: { description: "Set, manage, or check an autonomous goal" },
};

const GROK_DESCRIPTIONS = Object.fromEntries(Object.entries(GROK_COMMANDS).flatMap(([name, command]) => [
  [name, command.description],
  ...(command.aliases ?? []).map((alias) => [alias, command.description]),
]));
const PAGER_NAMES = Object.entries(GROK_COMMANDS).flatMap(([name, command]) => command.terminal ? [name, ...(command.aliases ?? [])] : []);
// Catalog the pinned official release build. Per-command flags above copy the pager modules'
// `visible()` and release-profile gate rather than a separately maintained hidden-name set.
const RELEASE_BUILD = true;
const GROK_AGENT_HIDDEN = Object.entries(GROK_COMMANDS)
  .filter(([, command]) => command.hidden || (RELEASE_BUILD && command.releaseHidden))
  .map(([name]) => name);

function absolute(path: unknown, home: string): string | null {
  if (typeof path !== "string") return null;
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path.startsWith("/") ? resolve(path) : null;
}

function skillsTable(configDir: string, home: string): { paths: string[]; ignore: string[] } {
  try {
    const table = (Bun.TOML.parse(readFileSync(join(configDir, "config.toml"), "utf8")) as { skills?: { paths?: unknown; ignore?: unknown } }).skills;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((entry) => absolute(entry, home) ?? []) : []);
    return { paths: list(table?.paths), ignore: list(table?.ignore) };
  } catch { return { paths: [], ignore: [] }; }
}

interface Root {
  readonly path: string;
  readonly origin: NonNullable<SlashCommand["origin"]>;
  readonly scope: string;
  readonly commands: boolean;
}

function pluginRoots(root: string, installed: boolean): Root[] {
  const result: Root[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (statSync(path).isDirectory()) result.push({ path: join(path, "skills"), origin: "plugin", scope: entry.name, commands: false });
    }
  } catch {}
  if (installed) {
    try {
      const plugins = (JSON.parse(readFileSync(join(root, "installed_plugins.json"), "utf8")) as {
        plugins?: Record<string, Array<{ installPath?: unknown }>>;
      }).plugins ?? {};
      for (const [name, versions] of Object.entries(plugins)) {
        for (const version of versions) {
          if (typeof version.installPath === "string") result.push({
            path: join(version.installPath, "skills"), origin: "plugin", scope: name.split("@")[0]!, commands: false,
          });
        }
      }
    } catch {}
  }
  return result;
}

/** Grok's legacy command roots contain flat markdown files, not SKILL.md directories. */
function legacyCommands(root: string, origin: Root["origin"]): SlashCommand[] {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
    const path = join(root, entry.name);
    try {
      return [{
        name: entry.name.slice(0, -3),
        description: readFileSync(path, "utf8").trim().split(/\r?\n/).find((line) => line.trim()) ?? "",
        source: origin === "plugin" ? "plugin" : origin === "user" ? "user" : "project",
        origin,
        id: canonicalFile(path),
      }];
    } catch { return []; }
  });
}

export const source: AgentCommandSource = {
  builtins: Object.keys(GROK_DESCRIPTIONS),
  descriptions: GROK_DESCRIPTIONS,
  pin: "1.0.62",
  terminalBound: PAGER_NAMES,
  agentHidden: GROK_AGENT_HIDDEN,
  forms: Object.fromEntries(PAGER_NAMES.map((name) => [name, [{ match: "bare" as const, interaction: "terminal" as const }]])),
  discover({ home, cwd, repoRoot, env }) {
    const grokHome = absolute(environValue(env, "GROK_HOME"), home) ?? join(home, ".grok");
    const cursorEnabled = environValue(env, "GROK_CURSOR_SKILLS_ENABLED") !== "false";
    const claudeEnabled = environValue(env, "GROK_CLAUDE_SKILLS_ENABLED") !== "false";
    const { paths, ignore } = skillsTable(grokHome, home);
    const directories: string[] = [];
    if (cwd) {
      const repo = resolve(repoRoot ?? cwd);
      for (let directory = resolve(cwd); ; directory = dirname(directory)) {
        directories.push(directory);
        if (directory === repo || directory === dirname(directory)) break;
      }
    }
    const tiers = [...new Set(directories)];
    const roots: Root[] = [];
    const add = (path: string, scope: string, origin: Root["origin"], commands = false): void => {
      roots.push({ path, scope, origin, commands });
    };

    for (const [index, directory] of tiers.entries()) {
      const local = index === 0;
      const repo = repoRoot != null && directory === resolve(repoRoot);
      const scope = local ? "local" : repo ? "repo" : "local";
      add(join(directory, ".grok", "skills"), scope, "project");
      add(join(directory, ".grok", "commands"), scope, "project", true);
      add(join(directory, ".agents", "skills"), scope, "project");
      add(join(directory, ".agents", "commands"), scope, "project", true);
      if (claudeEnabled) {
        add(join(directory, ".claude", "skills"), scope, "project");
        add(join(directory, ".claude", "commands"), scope, "project", true);
      }
      if (cursorEnabled) add(join(directory, ".cursor", "skills"), scope, "project");
    }
    add(join(grokHome, "skills"), "user", "user");
    add(join(grokHome, "commands"), "user", "user", true);
    if (claudeEnabled) {
      add(join(home, ".claude", "skills"), "user", "user");
      add(join(home, ".claude", "commands"), "user", "user", true);
    }
    if (cursorEnabled) add(join(home, ".cursor", "skills"), "user", "user");
    add(join(home, ".agents", "skills"), "user", "user");
    add(join(home, ".agents", "commands"), "user", "user", true);
    for (const path of paths) add(path, "user", "user");
    add(join(grokHome, "bundled", "skills"), "bundled", "bundled");
    for (const directory of tiers) {
      roots.push(...pluginRoots(join(directory, ".grok", "plugins"), false));
      roots.push(...pluginRoots(join(directory, ".claude", "plugins"), false));
    }
    roots.push(...pluginRoots(join(grokHome, "plugins"), false));
    roots.push(...pluginRoots(join(home, ".claude", "plugins"), true));

    const candidates: Array<{ key: string; scope: string; row: SlashCommand }> = [];
    const addCandidate = (key: string, scope: string, row: SlashCommand): void => {
      candidates.push({ key, scope, row });
    };
    for (const root of roots) {
      if (root.commands) {
        for (const command of legacyCommands(root.path, root.origin)) {
          if (!ignore.some((path) => resolve(path) === resolve(root.path))) {
            addCandidate(command.name, root.scope, command);
          }
        }
        continue;
      }
      let rootIsFile = false;
      try { rootIsFile = statSync(root.path).isFile(); } catch {}
      const skills = rootIsFile
        ? (() => {
          const fields = readFrontmatter(root.path);
          if (!fields || typeof fields.description !== "string" || !fields.description.trim()) return [];
          const name = typeof fields.name === "string" && fields.name.trim() ? fields.name : basename(dirname(root.path));
          return [{ name, description: description(readFileSync(root.path, "utf8")), path: root.path, fields, id: canonicalFile(root.path) }];
        })()
        : walkSkills(root.path, { depth: "recursive", looseMarkdown: "none", ignoreFiles: false, requireDescription: true });
      for (const skill of skills) {
        if (skill.fields["user-invocable"] === false) continue;
        const directory = dirname(skill.path);
        if (ignore.some((path) => directory === path || directory.startsWith(path + sep))) continue;
        addCandidate(skill.name, root.scope, {
          name: skill.name,
          description: skill.description,
          source: "skill",
          origin: root.origin,
          id: skill.id,
        });
      }
    }
    const grouped = new Map<string, typeof candidates>();
    for (const candidate of candidates) grouped.set(candidate.key, [...(grouped.get(candidate.key) ?? []), candidate]);
    const result: SlashCommand[] = [];
    for (const [key, rows] of grouped) {
      // a same-named local, repo or user skill overrides the bundled copy; a plugin skill overrides
      // nothing and keeps its plugin:name, so only native skills contest the bare name
      const overridden = rows.some((candidate) => candidate.scope !== "bundled" && candidate.row.origin !== "plugin");
      const scopes = new Map<string, (typeof rows)[number]>();
      for (const candidate of rows) if (!scopes.has(candidate.scope) && !(overridden && candidate.scope === "bundled")) scopes.set(candidate.scope, candidate);
      const native = [...scopes.values()].filter((candidate) => candidate.row.origin !== "plugin").length;
      const collision = native > 1 || Object.hasOwn(GROK_DESCRIPTIONS, key);
      for (const [scope, candidate] of scopes) {
        const name = `${scope}:${key}`;
        result.push({ ...candidate.row, name: collision || candidate.row.origin === "plugin" ? name : key });
      }
    }
    return result;
  },
};
