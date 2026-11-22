/**
 * OpenCode ships two TUIs and the scan follows the one the pane runs: `context.version` 2.x reads
 * the v2 shape, anything else (including no version) keeps v1. Upstream, pinned:
 * - v1.19.3 packages/tui/src/app.tsx (slashName entries), component/prompt/index.tsx (editor, skills,
 *   move), routes/session/index.tsx (undo, redo), feature-plugins/system/diff-viewer.tsx (diff);
 *   packages/opencode/src/command/index.ts at e3c4eb24 (init and review).
 * - v2.0.32 packages/tui/src/app.tsx at 843a6c51 (slash entries: open, clear, highlights, pair,
 *   reload, settings, update, restart), component/prompt/index.tsx (cd, worktrees), session-frame.tsx (terminal),
 *   feature-plugins/system/stats.tsx (stats), feature-plugins/prompt/btw.tsx (btw); move is gone.
 * - https://opencode.ai/v2/docs/skills/ and /commands/ for the v2 skill ids, @ trigger and directories.
 * `builtins` holds the names both versions share; a source has one static list, so the version-only ones
 * (the v1 and v2 additions) come from discover with their own provenance.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, description, environRecord, MAX_WALK_FOLDERS, parseJsonc, readConfigText, readSkillText, walkSkills } from "./walk.ts";

const BUNDLED_DESCRIPTION = "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.";
const DESCRIPTIONS = {
  agents: "Switch agent", connect: "Connect provider", debug: "View debug info", diff: "Open diff viewer",
  editor: "Open editor", exit: "Exit the app", help: "Help",
  init: "guided AGENTS.md setup", mcps: "Toggle MCPs", models: "Switch model",
  new: "New session", redo: "Redo",
  review: "review changes [commit|branch|pr], defaults to uncommitted",
  sessions: "Switch session", skills: "Skills", status: "View status", themes: "Switch theme",
  undo: "Undo previous message", variants: "Switch model variant",
} as const;
const TERMINAL: CommandForm[] = [{ match: "bare", interaction: "terminal" }];
// status, debug and help are dialogs kept until Esc, and diff a route or a panel that takes focus (app.tsx at v1.19.3 and v2)
const PICKERS = ["agents", "connect", "editor", "mcps", "models", "sessions", "skills", "themes", "variants", "status", "debug", "help", "diff"] as const;
const FORMS: Record<string, CommandForm[]> = {
  ...Object.fromEntries(PICKERS.map((name) => [name, TERMINAL])),
  undo: [{ match: "bare", interaction: "none" }],
  redo: [{ match: "bare", interaction: "none" }],
};
const V1_PIN = "1.19.3";
const V2_PIN = "2.0.32";
type Builtin = { name: string; description: string; forms?: CommandForm[]; visibility?: "offered" | "terminal" };
// Registered in v1 only, or worded differently from v2. routes/session/index.tsx (rename, timeline, fork,
// compact, timestamps, thinking, copy, export) and component/prompt/index.tsx (move, warp) are the TUI's
// own dialogs and display toggles; app.tsx registers org and update only under a runtime condition
// (a console login, an updater) and workspaces and warp only behind OPENCODE_EXPERIMENTAL_WORKSPACES,
// which a scan cannot see: they are listed, and the terminal says whether this session has them.
const V1_BUILTINS: readonly Builtin[] = [
  { name: "compact", description: "Compact session" },
  { name: "copy", description: "Copy session transcript", forms: TERMINAL, visibility: "terminal" },
  { name: "export", description: "Export session transcript", forms: TERMINAL, visibility: "terminal" },
  { name: "fork", description: "Fork session", forms: TERMINAL, visibility: "terminal" },
  { name: "move", description: "Move to another project dir" },
  { name: "org", description: "Switch org", forms: TERMINAL, visibility: "terminal" },
  { name: "rename", description: "Rename session", forms: TERMINAL, visibility: "terminal" },
  { name: "thinking", description: "Expand or collapse thinking", forms: TERMINAL, visibility: "terminal" },
  { name: "timeline", description: "Jump to message", forms: TERMINAL, visibility: "terminal" },
  { name: "timestamps", description: "Show or hide timestamps", forms: TERMINAL, visibility: "terminal" },
  { name: "update", description: "Update OpenCode" },
  { name: "warp", description: "Change the workspace for the session", forms: TERMINAL, visibility: "terminal" },
  { name: "workspaces", description: "Manage workspaces", forms: TERMINAL, visibility: "terminal" },
];
const V2_BUILTINS: readonly Builtin[] = [
  { name: "btw", description: "Ask a side question", forms: [...TERMINAL, { match: "other", interaction: "terminal" }] },
  { name: "cd", description: "Change working directory" },
  { name: "clear", description: "Clear session" },
  // routes/session/index.tsx: dialogs and clipboard work the TUI alone shows; compact has no form the block gives
  { name: "compact", description: "Compact session" },
  { name: "copy", description: "Copy last assistant message", forms: TERMINAL, visibility: "terminal" },
  { name: "export", description: "Export session transcript", forms: TERMINAL, visibility: "terminal" },
  { name: "fork", description: "Fork session", forms: TERMINAL, visibility: "terminal" },
  { name: "highlights", description: "Show release highlights" },
  { name: "open", description: "Open session or project", forms: TERMINAL },
  { name: "pair", description: "Pair device" },
  { name: "plugins", description: "Plugins", forms: TERMINAL, visibility: "terminal" },
  { name: "reload", description: "Reload configuration" },
  // bare opens the rename dialog; with a title (arguments: true) it renames in place
  { name: "rename", description: "Rename session", forms: [...TERMINAL, { match: "other", interaction: "unknown" }] },
  // /update and /restart register only when the TUI has an updater or a restartable service, which a
  // scan cannot see: they are listed, and the terminal says whether this session has them
  { name: "restart", description: "Restart service" },
  // dialogs the TUI alone shows (app.tsx DialogConfig, prompt/index.tsx workspace manager)
  { name: "settings", description: "Open settings", forms: TERMINAL, visibility: "terminal" },
  { name: "stats", description: "Usage statistics" },
  { name: "terminal", description: "New terminal" },
  { name: "timeline", description: "Jump to message", forms: TERMINAL, visibility: "terminal" },
  { name: "update", description: "Update OpenCode" },
  { name: "worktrees", description: "Manage workspaces", forms: TERMINAL, visibility: "terminal" },
];

const majorMinor = (version: string): string => version.split(".").slice(0, 2).join(".");
const isV2 = (version: string | null | undefined): boolean => Number(/^(\d+)(?:\.|$)/.exec(version ?? "")?.[1] ?? 1) >= 2;
const canonical = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

function configCommands(path: string, source: "user" | "project", key: string): SlashCommand[] {
  try {
    // bounded and regular files only: a FIFO or a huge file here would hold the server's one thread
    const config: unknown = parseJsonc(readConfigText(path));
    if (typeof config !== "object" || config === null || !(key in config)) return [];
    const commands = (config as Record<string, unknown>)[key];
    if (typeof commands !== "object" || commands === null || Array.isArray(commands)) return [];
    return Object.entries(commands).flatMap(([name, value]): SlashCommand[] => {
      if (typeof value !== "object" || value === null || !("template" in value) || typeof value.template !== "string") return [];
      return [{ name, description: "description" in value && typeof value.description === "string" ? value.description : "", source }];
    });
  } catch { return []; }
}

export const MAX_COMMAND_FILES = 1024;

function commandFiles(root: string): { name: string; path: string }[] {
  const files: { name: string; path: string }[] = [];
  const ancestors = new Set<string>();
  let folders = 0;
  const visit = (directory: string): void => {
    // the link guard covers the current branch only: sibling links to shared folders make an acyclic
    // tree exponential, and this runs on the server's thread, so it shares the skill walk's bound
    if (++folders > MAX_WALK_FOLDERS) return;
    const real = canonical(directory);
    if (ancestors.has(real)) return;
    ancestors.add(real);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          if (files.length >= MAX_COMMAND_FILES) return;
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md")) files.push({ name: relative(root, path).slice(0, -3).split(sep).join("/"), path });
        } catch { continue; }
      }
    } catch { } finally { ancestors.delete(real); }
  };
  visit(root);
  return files;
}

export const source: AgentCommandSource = {
  builtins: Object.keys(DESCRIPTIONS),
  descriptions: DESCRIPTIONS,
  forms: FORMS,
  terminalBound: ["agents", "connect", "editor", "sessions", "skills", "themes"],
  pin: [V1_PIN, V2_PIN],
  discover(ctx) {
    const v2 = isV2(ctx.version);
    const env = environRecord(ctx.env);
    const config = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(ctx.home, ".config"), "opencode");
    const projects = ctx.cwd ? ancestorsToRepoRoot(ctx.cwd, ctx.home).reverse() : [];
    const commands = new Map<string, SlashCommand>();
    const directories: readonly (readonly [string, "user" | "project"])[] = [
      [config, "user"],
      ...projects.flatMap((directory): [string, "project"][] => [[directory, "project"], [join(directory, ".opencode"), "project"]]),
    ];
    const descriptions = new Map<string, string>();
    for (const [directory, source] of directories) {
      // File commands override config commands at the same root.
      for (const filename of ["opencode.json", "opencode.jsonc"]) {
        for (const command of configCommands(join(directory, filename), source, v2 ? "commands" : "command")) commands.set(command.name, command);
      }
      if (source === "project" && basename(directory) !== ".opencode") continue;
      // the singular directory is legacy in v2 and still read; the plural one wins a clash
      for (const kind of ["command", "commands"]) {
        for (const { name, path } of commandFiles(join(directory, kind))) {
          const id = canonical(path);
          let text = descriptions.get(id);
          if (text === undefined) {
            try { text = description(readSkillText(path)); } catch { continue; }
            descriptions.set(id, text);
          }
          commands.set(name, { name, description: text, source, id });
        }
      }
    }
    const skills = new Map<string, SlashCommand>([["customize-opencode", {
      name: "customize-opencode", description: BUNDLED_DESCRIPTION, source: "skill", origin: "bundled", ...(v2 ? { trigger: "@" as const } : {}),
    }]]);
    const disabled = (key: string) => env[key] === "1" || env[key] === "true";
    const external = !disabled("OPENCODE_DISABLE_EXTERNAL_SKILLS");
    // the Claude flags remove only the .claude roots; .agents stays
    const claude = external && !disabled("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS") && !disabled("OPENCODE_DISABLE_CLAUDE_CODE");
    const roots: { path: string; origin: "user" | "project" }[] = [];
    if (external) {
      const kinds = [...(claude ? [".claude"] : []), ".agents"];
      const place = (directory: string, kind: string) => roots.push({ path: join(directory, kind, "skills"), origin: directory === ctx.home ? "user" : "project" });
      // v2 registers every .claude root before every .agents root; v1 goes directory by directory
      if (v2) for (const kind of kinds) for (const directory of [ctx.home, ...projects]) place(directory, kind);
      else for (const directory of [ctx.home, ...projects]) for (const kind of kinds) place(directory, kind);
    }
    for (const directory of [config, ...projects.map((directory) => join(directory, ".opencode"))]) {
      for (const kind of v2 ? ["skills"] : ["skill", "skills"]) roots.push({ path: join(directory, kind), origin: directory === config ? "user" : "project" });
    }
    for (const { path, origin } of roots) {
      for (const skill of walkSkills(path, { depth: "recursive", looseMarkdown: v2 ? "root" : "none", ignoreFiles: false, requireDescription: false })) {
        const text = skill.fields.description;
        if (v2) {
          // v2: the path names the skill; the frontmatter name is only a label and nothing is validated
          const id = basename(skill.path) !== "SKILL.md" ? basename(skill.path, ".md") : dirname(skill.path) === path ? "SKILL" : basename(dirname(skill.path));
          skills.set(id, { name: id, description: typeof text === "string" ? text.trim() : "", source: "skill", trigger: "@", origin, id: canonical(skill.path) });
          continue;
        }
        // v1 needs a string name that matches its directory; the description is optional
        const name = skill.fields.name;
        if (typeof name !== "string" || name !== basename(dirname(skill.path)) || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ||
          (text !== undefined && typeof text !== "string") || (typeof text === "string" && text.length > 1024)) continue;
        skills.set(name, { name, description: typeof text === "string" ? text.trim() : "", source: "skill", origin, id: canonical(skill.path) });
      }
    }
    // Commands win over skills, including builtins; custom builtin overrides keep just one row.
    const pin = v2 ? V2_PIN : V1_PIN;
    const extras: SlashCommand[] = (v2 ? V2_BUILTINS : V1_BUILTINS).map(({ name, description, forms, visibility }) => ({
      name, description, source: "builtin", visibility: visibility ?? "offered", forms: forms ?? [{ match: "bare", interaction: "unknown" }],
      provenance: { transport: "static", verified: !!ctx.version && majorMinor(ctx.version) === majorMinor(pin) },
    }));
    const builtinNames = new Set<string>([...source.builtins, ...extras.map((row) => row.name)]);
    return [
      ...extras,
      ...[...commands.values()].filter((command) => !builtinNames.has(command.name)),
      ...[...skills.values()].filter((skill) => v2 ? true : !commands.has(skill.name) && !builtinNames.has(skill.name)),
    ];
  },
};
