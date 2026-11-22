import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./grok.ts";

/*
 * Grok 1.0.62 user guide (xai-org/grok-build, pinned commit
 * 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8).
 *
 * docs/user-guide/08-skills.md, lines 18-33:
 * | `./.grok/skills/`, `./.grok/commands/` | Local (CWD) | Highest |
 * | `<repo_root>/.grok/skills/`, `…/commands/` | Repo | Medium |
 * | `~/.grok/skills/`, `~/.grok/commands/` | User | Lowest |
 * | `~/.claude/skills/`, `~/.claude/commands/` | User | Lowest |
 * | `./.claude/skills/`, `./.claude/commands/` | Local / Repo | High |
 * | `~/.cursor/skills/` | User | Lowest |
 * | `./.cursor/skills/` | Local / Repo | High |
 * | `./.agents/skills/` (and `commands/`) | Same tiers as `.grok/` |
 * Grok walks every directory between the working directory and repo root.
 * Flat `*.md` files under `commands/` become slash commands (filename stem = command name).
 * Discovery does not use `.gitignore`; known roots load when present on disk.
 *
 * docs/user-guide/08-skills.md, lines 195-213:
 * `~/.grok/bundled/skills/` is the bundled skill cache; Grok never writes these into
 * `~/.grok/skills/`. A same-named local, repo or user skill overrides the bundled copy.
 * A plugin skill of the same name does not override a native skill; it remains available as
 * `plugin:name`.
 *
 * docs/user-guide/04-slash-commands.md: shell builtins are backend-handled, pager builtins are
 * frontend-handled; both appear in the slash menu. Pager forms cannot be driven by Chat.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "grok-skills-"));
  dirs.push(dir);
  return dir;
}
function skill(root: string, name: string, description: string | null = `Does ${name}`, fieldName: string | null = name): void {
  const lines = ["---", ...(fieldName ? [`name: ${fieldName}`] : []), ...(description ? [`description: ${description}`] : []), "---", "Body"];
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), lines.join("\n"));
}
const skillsOf = (commands: ReturnType<typeof paneCommands>) => commands.filter((command) => command.source === "skill").map(({ name, origin, description }) => ({ name, origin, description }));

// Canonical pager rows copied from the pinned modules' slash_meta! blocks, plus the shell-only
// BUILTIN_COMMANDS. Aliases inherit their canonical row's description, as Pager CommandTrigger does.
// voice's text varies with terminal key-release support; its stable Ctrl+Space/F8 chord is pinned.
const PINNED_COMMAND_TABLE: readonly {
  name: string;
  description: string;
  aliases?: readonly string[];
  terminal?: boolean;
  agentHidden?: boolean;
}[] = [
  { name: "tutorial", description: "Quick tips to get the most out of Grok Build", aliases: ["tour", "onboarding"], terminal: true },
  { name: "settings", description: "Open the settings modal", aliases: ["config", "preferences", "prefs"], terminal: true },
  { name: "dashboard", description: "Open the Agent Dashboard", aliases: ["agents-dashboard", "sessions"], terminal: true },
  { name: "workflows", description: "Browse installed workflows", terminal: true },
  { name: "hooks", description: "View hooks", terminal: true },
  { name: "plugins", description: "View plugins", aliases: ["plugin"], terminal: true },
  { name: "marketplace", description: "View marketplace", terminal: true },
  { name: "skills", description: "View skills", terminal: true },
  { name: "btw", description: "Ask a side question without interrupting", terminal: true },
  { name: "voice", description: "Ctrl+Space/F8; Esc/Enter to stop", terminal: true },
  { name: "new", description: "Start a new session", aliases: ["clear"], terminal: true },
  { name: "effort", description: "Set reasoning effort for the current model", terminal: true },
  { name: "context-window", description: "Set the context window for the current model", terminal: true },
  { name: "model", description: "Switch the active model", aliases: ["m"], terminal: true },
  { name: "context", description: "View context usage", terminal: true },
  { name: "compact", description: "Compact conversation history", terminal: true },
  { name: "fork", description: "Branch the current session into a peer agent", terminal: true },
  { name: "resume", description: "Resume a previous session", terminal: true },
  { name: "loop", description: "Run a prompt on a recurring interval", terminal: true },
  { name: "plan", description: "Enter plan mode", terminal: true },
  { name: "view-plan", description: "View the current plan", aliases: ["show-plan", "plan-view"], terminal: true },
  { name: "remember", description: "Save a memory note", terminal: true },
  { name: "memory", description: "Browse, view, and manage your memories", aliases: ["mem"], terminal: true },
  { name: "flush", description: "Save this session's memory to disk now", terminal: true },
  { name: "dream", description: "Consolidate memory now (merge observations into topics)", terminal: true },
  { name: "recap", description: "Summarize the session so far", aliases: ["summarize"], terminal: true },
  { name: "rewind", description: "Rewind to a previous turn", aliases: ["undo"], terminal: true },
  { name: "jump", description: "Jump to a turn in the conversation", terminal: true },
  { name: "expand", description: "Re-print the last collapsed block, fully expanded (minimal mode)", terminal: true },
  { name: "edit-prompt", description: "Open an external editor for an empty prompt; use the command palette to preserve a draft", terminal: true },
  { name: "queue", description: "List the prompts queued behind the running turn", terminal: true },
  { name: "session-info", description: "Show session info", aliases: ["status", "info"], terminal: true },
  { name: "share", description: "Share this session via URL", terminal: true },
  { name: "rename", description: "Rename the current session", aliases: ["title"], terminal: true },
  { name: "history", description: "Search prompt history", terminal: true },
  { name: "transcript", description: "View the conversation transcript in your pager ($PAGER)", aliases: ["log"], terminal: true },
  { name: "export", description: "Export the current conversation to a file or clipboard", terminal: true },
  { name: "copy", description: "Copy last response to clipboard or file (/copy [N] [file])", terminal: true },
  { name: "find", description: "Search the conversation scrollback", terminal: true },
  { name: "usage", description: "View usage", aliases: ["cost"], terminal: true },
  { name: "tasks", description: "List background tasks, subagents, and scheduled tasks", terminal: true },
  { name: "mcps", description: "Show MCP server status", terminal: true },
  { name: "workflow", description: "Launch a saved workflow, list runs, or manage a run (pause, resume, stop, save)", terminal: true },
  { name: "personas", description: "Manage personas (create, edit, delete)", terminal: true },
  { name: "config-agents", description: "Manage agent definitions", aliases: ["agents"], terminal: true },
  { name: "theme", description: "Switch the color theme", aliases: ["t"], terminal: true },
  { name: "auto", description: "Toggle Auto-review (classifier approves safe tools)", terminal: true },
  { name: "always-approve", description: "Toggle always-approve mode (skip all permission prompts)", aliases: ["yolo"], terminal: true },
  { name: "vim-mode", description: "Toggle vim-style scrollback keybindings (j/k, h/l, g/G, y/Y, …)", terminal: true },
  { name: "multiline", description: "Toggle multiline input mode (swap Enter and Shift+Enter)", aliases: ["ml"], terminal: true },
  { name: "compact-mode", description: "Toggle compact UI (less padding, more content)", terminal: true },
  { name: "timestamps", description: "Toggle message timestamps on/off", terminal: true },
  { name: "toggle-mouse-reporting", description: "Toggle terminal mouse reporting (native click-drag copy/paste)", terminal: true },
  { name: "timeline", description: "Toggle the timeline sidebar", terminal: true },
  { name: "cd", description: "Change the working directory for new agents", terminal: true },
  { name: "imagine", description: "Generate an image from a text description", terminal: true },
  { name: "imagine-video", description: "Generate a video from a text description", terminal: true },
  { name: "docs", description: "Open How-to Guides or online Build docs", aliases: ["howto", "guides"], terminal: true },
  { name: "release-notes", description: "View release notes for the current version", aliases: ["changelog"], terminal: true },
  { name: "announcements", description: "Show or hide announcements", terminal: true },
  { name: "feedback", description: "Send feedback about the current session", terminal: true },
  { name: "privacy", description: "Open coding data, retention, and training settings", terminal: true },
  { name: "doctor", description: "Check this session and show available fixes", aliases: ["terminal-setup", "terminal-check", "terminal-info"], terminal: true },
  { name: "import-claude", description: "Open the Claude settings import modal", terminal: true },
  { name: "login", description: "Log in or re-authenticate with your account", terminal: true },
  { name: "logout", description: "Log out and return to the login screen", terminal: true },
  { name: "home", description: "Return to the welcome screen", aliases: ["welcome"], terminal: true },
  { name: "delete", description: "Delete this session", terminal: true },
  { name: "help", description: "Browse commands and keyboard shortcuts", terminal: true },
  { name: "quit", description: "Quit the application", aliases: ["exit"], terminal: true },
  { name: "gboom", description: "Hidden easter egg", agentHidden: true },
  { name: "debug", description: "Toggle debug overlays", agentHidden: true },
  { name: "minimal", description: "Switch this session to minimal (scrollback-native) mode, back with /fullscreen", terminal: true },
  { name: "fullscreen", description: "Switch this session to fullscreen mode, back with /minimal", aliases: ["full"], terminal: true },
  { name: "hooks-trust", description: "Trust this project for hook execution", agentHidden: true },
  { name: "hooks-list", description: "Show hooks loaded in this session", agentHidden: true },
  { name: "hooks-add", description: "Add a custom hook file or directory", agentHidden: true },
  { name: "hooks-remove", description: "Remove a custom hook file or directory path", agentHidden: true },
  { name: "hooks-untrust", description: "Remove trust for the current project", agentHidden: true },
  { name: "reload-plugins", description: "Reload plugins from disk (alias for /plugins reload)", agentHidden: true },
  { name: "deep-research", description: "Research with bounded parallel agents, cross-check evidence, and write a cited report" },
  { name: "goal", description: "Set, manage, or check an autonomous goal" },
];

describe("grok skills", () => {
  it("marks each upstream-hidden pager command agent-hidden, never terminal", () => {
    // gboom.rs:25-26 is always hidden; debug.rs:21,43-44 is hidden in release builds.
    for (const name of ["gboom", "debug"]) {
      const row = paneCommands("grok", null, temp()).find((command) => command.name === name);
      expect(source.agentHidden).toContain(name);
      expect(source.terminalBound).not.toContain(name);
      expect(row?.visibility).toBe("agent-hidden");
    }
  });

  it("matches the pinned builtin names, descriptions, aliases, and visibility", () => {
    const expected = Object.fromEntries(PINNED_COMMAND_TABLE.flatMap(({ name, description, aliases = [] }) => [
      [name, description],
      ...aliases.map((alias) => [alias, description]),
    ]));
    expect(source.pin).toBe("1.0.62");
    expect(source.descriptions).toEqual(expected);
    expect([...source.builtins].sort()).toEqual(Object.keys(expected).sort());
    expect([...(source.terminalBound ?? [])].sort()).toEqual(PINNED_COMMAND_TABLE.flatMap(({ name, aliases = [], terminal }) => terminal ? [name, ...aliases] : []).sort());
    expect(source.agentHidden).toEqual(PINNED_COMMAND_TABLE.filter((row) => row.agentHidden).map(({ name }) => name));
  });

  it("keeps nested cwd and repo skills as distinct documented scopes", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    skill(join(cwd, ".grok", "skills"), "same", "Local copy");
    skill(join(repo, ".grok", "skills"), "same", "Repo copy");

    const names = skillsOf(paneCommands("grok", cwd, home)).map(({ name }) => name);
    expect(names).toEqual(["local:same", "repo:same"]);
  });

  it("marks every pinned pager command and alias as terminal", () => {
    // Grok 1.0.62 pager registry and 04-slash-commands.md command names and aliases.
    const documentedPagerCommands = [
      "new", "clear", "resume", "dashboard", "agents-dashboard", "sessions", "compact", "context",
      "session-info", "status", "info", "fork", "rewind", "undo",
      "copy", "export", "quit", "exit", "home", "welcome", "delete", "rename", "title",
      "model", "m", "effort", "context-window", "always-approve", "yolo", "auto", "multiline", "ml",
      "history", "compact-mode", "vim-mode",
      "edit-prompt", "minimal", "fullscreen", "full", "plan", "view-plan", "show-plan", "plan-view",
      "memory", "mem", "flush", "dream", "hooks", "plugins", "plugin", "marketplace", "skills", "workflows", "theme", "t",
      "feedback", "mcps", "doctor", "terminal-setup", "terminal-check", "terminal-info", "docs",
      "howto", "guides", "tutorial", "tour", "onboarding", "config-agents", "agents", "personas",
      "login", "logout", "usage", "cost", "privacy", "settings", "config", "preferences", "prefs",
      "timestamps", "find", "jump", "timeline", "expand", "import-claude", "release-notes", "changelog",
      "voice", "loop", "remember", "recap", "summarize", "queue", "share", "transcript", "log",
      "tasks", "toggle-mouse-reporting", "cd", "announcements", "help",
      "btw", "workflow", "imagine", "imagine-video",
    ];
    expect([...documentedPagerCommands].sort()).toEqual(PINNED_COMMAND_TABLE.flatMap(({ name, aliases = [], terminal }) => terminal ? [name, ...aliases] : []).sort());
    const rows = new Map(paneCommands("grok", null, temp()).map(({ name, visibility, forms }) => [name, { visibility, forms }]));
    for (const name of documentedPagerCommands) {
      expect(rows.get(name), `missing pager command /${name}`).toMatchObject({
        visibility: "terminal",
        forms: [{ match: "bare", interaction: "terminal" }],
      });
    }
  });

  it("offers documented shell commands and marks pager commands terminal", () => {
    const names = paneCommands("grok", null, temp()).filter((command) => command.source === "builtin").map((command) => command.name).sort();
    expect(names).toContain("context");
    expect(names).toContain("session-info");
    expect(names).toContain("deep-research");
    expect(names).toContain("workflow");
    expect(names).toContain("goal");
    expect(names).not.toContain("load");
    expect(names).toContain("resume");
    expect(source.terminalBound).toContain("model");
    expect(source.agentHidden ?? []).not.toContain("model");
  });

  it("reads project, user, Claude and plugin roots with their origins", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    skill(join(cwd, ".grok", "skills"), "local-one");
    skill(join(repo, ".grok", "skills"), "repo-one");
    skill(join(repo, ".claude", "skills"), "claude-project");
    skill(join(home, ".grok", "skills"), "mine");
    skill(join(home, ".claude", "skills"), "claude-user");
    skill(join(home, ".grok", "plugins", "team", "skills"), "from-plugin");
    const installed = join(home, "cache", "tools");
    skill(join(installed, "skills"), "claude-plugin");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: installed }] } }));
    const found = Object.fromEntries(skillsOf(paneCommands("grok", cwd, home)).map(({ name, origin }) => [name, origin]));
    expect(found).toEqual({ "local-one": "project", "repo-one": "project", "claude-project": "project", mine: "user", "claude-user": "user", "team:from-plugin": "plugin", "tools:claude-plugin": "plugin" });
  });

  it("lets the higher priority win a duplicate name", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    skill(join(repo, ".grok", "skills"), "commit", "Project commit");
    skill(join(home, ".grok", "skills"), "commit", "User commit");
    expect(skillsOf(paneCommands("grok", repo, home))).toEqual([
      { name: "local:commit", origin: "project", description: "Project commit" },
      { name: "user:commit", origin: "user", description: "User commit" },
    ]);
  });

  it("requires both name and description", () => {
    const home = temp();
    skill(join(home, ".grok", "skills"), "complete");
    skill(join(home, ".grok", "skills"), "no-description", null);
    skill(join(home, ".grok", "skills"), "no-name", "Present", null);
    expect(skillsOf(paneCommands("grok", null, home)).map((command) => command.name)).toEqual(["complete", "no-name"]);
  });

  it("keeps repository skills even when .gitignore ignores their directory", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".gitignore"), "ignored-skill/\n");
    skill(join(repo, ".grok", "skills"), "ignored-skill");
    skill(join(repo, ".grok", "skills"), "tracked-skill");
    expect(skillsOf(paneCommands("grok", repo, home)).map(({ name, origin }) => [name, origin])).toEqual([["ignored-skill", "project"], ["tracked-skill", "project"]]);
  });

  it("scans every documented tier and bundled skills, keeping qualified collisions", () => {
    const home = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    skill(join(home, ".agents", "skills"), "agent-user");
    skill(join(home, ".grok", "bundled", "skills"), "bundle-only");
    skill(join(home, ".grok", "bundled", "skills"), "duplicate", "Bundled duplicate");
    skill(join(home, ".grok", "skills"), "duplicate", "User duplicate");
    skill(join(cwd, ".grok", "skills"), "duplicate", "Local duplicate");
    skill(join(cwd, ".agents", "skills"), "agent-local");
    skill(join(cwd, ".claude", "skills"), "claude-local");
    skill(join(cwd, ".cursor", "skills"), "cursor-local");
    skill(join(home, ".cursor", "skills"), "cursor-user");
    skill(join(home, ".claude", "skills", "synced"), "synced-user");
    skill(join(repo, ".agents", "skills"), "agent-repo");
    mkdirSync(join(repo, ".agents", "commands"), { recursive: true });
    writeFileSync(join(repo, ".agents", "commands", "ignored-command.md"), "Ignored command");
    mkdirSync(join(repo, ".grok", "commands"), { recursive: true });
    writeFileSync(join(repo, ".grok", "commands", "repo-command.md"), "Repo command");
    mkdirSync(join(home, ".grok", "commands"), { recursive: true });
    writeFileSync(join(home, ".grok", "commands", "user-command.md"), "User command");
    skill(join(repo, ".claude", "skills"), "claude-repo");
    skill(join(repo, ".cursor", "skills"), "cursor-repo");
    const rows = source.discover({ home, cwd, repoRoot: repo, env: null, roots: {} });
    expect(rows.map(({ name }) => name)).toContain("agent-user");
    expect(rows.map(({ name }) => name)).toContain("bundle-only");
    expect(rows.map(({ name }) => name)).toContain("agent-local");
    expect(rows.map(({ name }) => name)).toContain("agent-repo");
    expect(rows.map(({ name }) => name)).toContain("claude-local");
    expect(rows.map(({ name }) => name)).toContain("claude-repo");
    expect(rows.map(({ name }) => name)).toContain("cursor-local");
    expect(rows.map(({ name }) => name)).toContain("cursor-repo");
    expect(rows.map(({ name }) => name)).toContain("cursor-user");
    expect(rows.map(({ name }) => name)).toContain("ignored-command");
    expect(rows.map(({ name }) => name)).toContain("repo-command");
    expect(rows.map(({ name }) => name)).toContain("user-command");
    expect(rows.map(({ name }) => name)).toContain("user:duplicate");
    expect(rows.map(({ name }) => name)).toContain("local:duplicate");
    expect(rows.map(({ name }) => name).filter((name) => name.endsWith("duplicate"))).toEqual(["local:duplicate", "user:duplicate"]);
    expect(rows.map(({ name }) => name)).toContain("synced-user");
  });

  it("lets a native skill keep its bare name over a bundled or plugin skill of that name", () => {
    const home = temp();
    skill(join(home, ".grok", "bundled", "skills"), "review", "Bundled review");
    skill(join(home, ".grok", "skills"), "review", "User review");
    skill(join(home, ".grok", "plugins", "team", "skills"), "review", "Plugin review");
    expect(skillsOf(paneCommands("grok", null, home))).toEqual([
      { name: "review", origin: "user", description: "User review" },
      { name: "team:review", origin: "plugin", description: "Plugin review" },
    ]);
  });

  it("compiles pager commands as visible terminal forms", () => {
    expect(source.builtins).toContain("model");
    expect(source.terminalBound).toContain("model");
    expect(source.forms?.model).toEqual([{ match: "bare", interaction: "terminal" }]);
  });

  it("lists pager builtins as terminal rows in the pane catalog", () => {
    const model = paneCommands("grok", null, temp()).find((command) => command.name === "model");
    expect(model).toMatchObject({
      visibility: "terminal",
      forms: [{ match: "bare", interaction: "terminal" }],
    });
  });

  it("honors GROK_HOME from the pane process and the [skills] table of its config.toml", () => {
    const home = temp();
    const moved = temp();
    const extra = temp();
    const wip = join(extra, "wip");
    skill(join(home, ".grok", "skills"), "default-home");
    skill(join(moved, "skills"), "moved-home");
    skill(extra, "extra-one");
    skill(extra, "wip", "Work in progress");
    writeFileSync(join(moved, "config.toml"), `[skills]\npaths = ["${extra}", "relative/dir"]\nignore = ["${wip}"]\n`);
    const found = skillsOf(paneCommands("grok", null, home, { environ: [`GROK_HOME=${moved}`] })).map((command) => command.name);
    expect(found).toEqual(["extra-one", "moved-home"]);
  });

  it("lists nothing from a missing home and never throws on a broken config.toml", () => {
    const home = temp();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "config.toml"), "[skills\npaths = ");
    expect(skillsOf(paneCommands("grok", null, home))).toEqual([]);
    expect(skillsOf(paneCommands("grok", null, join(home, "absent")))).toEqual([]);
  });
});

describe("Grok skill identity", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-identity-"));
    roots.push(home);
    const real = join(home, ".agents", "skills");
    mkdirSync(join(real, "aliased"), { recursive: true });
    writeFileSync(join(real, "aliased", "SKILL.md"), "---\nname: aliased\ndescription: Aliased skill\n---\n");
    mkdirSync(join(home, ".grok"), { recursive: true });
    symlinkSync(real, join(home, ".grok", "skills"), "dir");
    const rows = paneCommands("grok", null, home).filter(({ name }) => name === "aliased");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", origin: "user", id: realpathSync(join(real, "aliased", "SKILL.md")) });
  });

  it("identifies a legacy command reached through a linked root by its real file", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-identity-"));
    roots.push(home);
    const real = join(home, ".agents", "commands");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "ship.md"), "Ship it\n");
    mkdirSync(join(home, ".grok"), { recursive: true });
    symlinkSync(real, join(home, ".grok", "commands"), "dir");
    const rows = paneCommands("grok", null, home).filter(({ name }) => name === "ship");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: realpathSync(join(real, "ship.md")) });
  });
});
