import { existsSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, readFrontmatter, walkSkills } from "./walk.ts";

// agy 1.2.16's embedded migration guide, checked with
// strings ~/.local/bin/agy | rg 'gemini/config/skills', names ~/.gemini/config/skills.
// ~/.gemini/antigravity-cli/skills is not in that binary and is deliberately not scanned.
// The 1.4.0 recorded palette is retained; terminal-only screens remain discoverable.
const descriptions = {
  "add-dir": "Add a directory to the workspace", artifact: "View and review artifacts",
  "agy-customizations": "Guide to the Antigravity Customization System",
  "antigravity-guide": "Guide and reference for Google Antigravity",
  agents: "Open the Agent Manager panel",
  btw: "Ask a side question without interrupting the current task",
  changelog: "Show release notes and changes", compact: "Compact conversation context",
  fork: "Branch the current conversation", branch: "Branch the current conversation",
  browser: "Invoke a browser agent for web tasks", boost: "Invoke the Boost multi-agent orchestrator",
  config: "Open the Settings Editor", credits: "View remaining G1 credits",
  feedback: "Submit feedback about the agent",
  clear: "Clear conversation and start a new one", new: "Clear conversation and start a new one",
  codesearch: "Search code in the workspace", cs: "Search code in the workspace", search: "Search code in the workspace",
  context: "Visualize current context usage", diff: "View uncommitted changes and per-turn diffs",
  rewind: "Rewind conversation to a previous message", undo: "Rewind conversation to a previous message",
  exit: "Exit the CLI", quit: "Exit the CLI", help: "Show commands and keybindings",
  open: "Open a file or view opened and edited files", goal: "Run until the specified goal is finished",
  "grill-me": "Interview me to align on a plan", usage: "View model quota usage", quota: "View model quota usage",
  fast: "Enable fast mode", hooks: "Browse active script hooks", keybindings: "Open the Keyboard Shortcut Editor",
  effort: "Set effort level for model usage",
  schedule: "Run an instruction on a schedule or as a one-time timer",
  title: "Toggle the terminal window title", tasks: "View background tasks", logout: "Log out",
  learn: "Capture reusable skills or rules from recent work", plan: "Plan before executing a task",
  planning: "Enable multi-turn plan generation mode", permissions: "Open the tool permissions manager",
  mcp: "Open the Model Context Protocol server manager", model: "Choose the preferred reasoning model",
  resume: "Open the conversation picker", plugin: "Open the Plugins Manager",
  skills: "Browse loaded local and global Agent Skills", voice: "Dictate a prompt using your microphone",
  rename: "Rename the current conversation", copy: "Copy a planner response to the clipboard",
  "teamwork-preview": "Invoke a team of agents for a large project",
  switch: "Open the conversation picker", conversation: "Open the conversation picker", teamwork: "Launch collaborative agent teams",
  record: "Dictate a prompt using your microphone",
  "remote-control": "Turn remote control on or off", statusline: "Toggle the statusline",
} as const;
const rules = { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true } as const;
// Antigravity CLI reference: https://antigravity.google/docs/cli/reference
const aliases: Readonly<Record<string, string>> = {
  switch: "resume", conversation: "resume", record: "voice", quota: "usage",
};
const canonicalName = (name: string): string => aliases[name] ?? name;
// The second line opened a panel, viewer, picker or form on a 1.4.3 screen check (2026-10-22): /rewind and /undo open
// the Rewind picker whatever follows them, and logout leaves the sign-in screen behind it.
const canonicalTerminalBound: ReadonlySet<string> = new Set(["model", "resume", "config", "permissions", "agents", "hooks", "mcp", "plugin", "skills", "voice", "effort", "keybindings", "usage", "credits", "changelog",
  "artifact", "codesearch", "cs", "search", "context", "diff", "help", "tasks", "rewind", "undo", "feedback", "logout"]);
const terminalBound: ReadonlySet<string> = new Set([
  ...canonicalTerminalBound,
  ...Object.keys(aliases).filter((name) => canonicalTerminalBound.has(canonicalName(name))),
]);
const loadedBuiltinSkills: ReadonlySet<string> = new Set(["agy-customizations", "antigravity-guide"]);
const terminalForm: CommandForm = { match: "bare", interaction: "terminal" };
const canonicalForms: Record<string, CommandForm[]> = Object.fromEntries(
  [...canonicalTerminalBound].map((name) => [name, [terminalForm]]),
);
const aliasForms = Object.fromEntries(
  Object.entries(aliases).flatMap(([name, canonical]) => canonicalForms[canonical] ? [[name, canonicalForms[canonical]]] : []),
);

export const source: AgentCommandSource = {
  builtins: Object.keys(descriptions),
  descriptions,
  // the recorded 1.4.0 palette the builtin list and descriptions were checked against
  pin: "1.4.0",
  terminalBound: [...terminalBound],
  // bare /open prints its usage; /open <file> opens the file in the PC's $EDITOR
  forms: { ...canonicalForms, ...aliasForms, open: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "terminal" }] },
  discover({ home, cwd, repoRoot }) {
    const found = new Map<string, SlashCommand>();
    const add = (name: string, description: string, fields: Readonly<Record<string, unknown>>, origin: SlashCommand["origin"], path: string): void => {
      if (fields["disable-slash-command"] === true || found.has(name) ||
        (origin === "bundled" && (!loadedBuiltinSkills.has(name) || Object.hasOwn(descriptions, name))) ||
        (origin === "bundled" && terminalBound.has(name))) return;
      found.set(name, { name, description, source: "skill", origin, id: realpathSync(path) });
    };
    const scan = (root: string, origin: SlashCommand["origin"]): void => {
      for (const skill of walkSkills(root, rules)) {
        add(skill.name, skill.description, skill.fields, origin, skill.path);
      }
    };
    const declared = (directory: string, origin: SlashCommand["origin"]): void => {
      const path = join(directory, "skills.json");
      if (!existsSync(path)) return;
      let config: unknown;
      try { config = JSON.parse(readFileSync(path, "utf8")); }
      catch { return; }
      if (!config || typeof config !== "object" || !("entries" in config) || !Array.isArray(config.entries)) return;
      for (const entry of config.entries) {
        if (!entry || typeof entry !== "object" || typeof entry.path !== "string") continue;
        const root = entry.path.startsWith("~/") ? join(home, entry.path.slice(2)) : resolve(repoRoot ?? directory, entry.path);
        const excluded: unknown[] = Array.isArray(entry.exclude) ? entry.exclude : [];
        if (Array.isArray(entry.include_only)) {
          for (const name of entry.include_only) {
            if (typeof name !== "string" || excluded.includes(name)) continue;
            const fields = readFrontmatter(join(root, name, "SKILL.md"));
            if (typeof fields?.description !== "string" || !fields.description.trim()) continue;
            const skillPath = join(root, name, "SKILL.md");
            add(typeof fields.name === "string" && fields.name ? fields.name : basename(name), fields.description, fields, origin, skillPath);
          }
        } else {
          for (const skill of walkSkills(root, rules)) {
            if (!excluded.includes(basename(dirname(skill.path)))) {
              add(skill.name, skill.description, skill.fields, origin, skill.path);
            }
          }
        }
      }
    };
    const project = cwd ? ancestorsToRepoRoot(cwd, home) : [];
    for (const directory of project) {
      for (const prefix of [".agents", ".agent", "_agents", "_agent"]) scan(join(directory, prefix, "skills"), "project");
    }
    for (const directory of project) {
      for (const prefix of [".agents", ".agent", "_agents", "_agent"]) declared(join(directory, prefix), "project");
    }
    const config = join(home, ".gemini", "config");
    scan(join(config, "skills"), "user");
    const plugins = join(config, "plugins");
    if (existsSync(plugins)) {
      for (const plugin of readdirSync(plugins)) scan(join(plugins, plugin, "skills"), "plugin");
    }
    scan(join(home, ".gemini", "antigravity-cli", "builtin", "skills"), "bundled");
    declared(config, "user");
    return [...found.values()];
  },
};
