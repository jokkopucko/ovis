import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import { hermesHome as resolveHermesHome, platformHermesHome } from "../hermes-home.ts";
import type { AgentCommandContext, AgentCommandSource } from "./index.ts";
import { canonicalFile as canonical, environRecord, plainObject, readFrontmatter, readSkillText } from "./walk.ts";

// Hermes 0.21.5 CommandDefs at 354724fb085162678964c116ceb4c40fc57c717c; CLI aliases are included.
// Gateway-only commands are never CLI rows. Runtime-only plugin commands are not listed.
const BUILTINS: Readonly<Record<string, string>> = {
  "new": "Start a new session (fresh session ID + history)",
  "reset": "Start a new session (fresh session ID + history)",
  "clear": "Clear screen and start a new session",
  "redraw": "Force a full UI repaint (recovers from terminal drift)",
  "history": "Show conversation history",
  "save": "Export the current conversation (bare /save shows usage)",
  "retry": "Retry the last message (resend to agent)",
  "prompt": "Compose your next prompt in $EDITOR (markdown), then send it",
  "compose": "Compose your next prompt in $EDITOR (markdown), then send it",
  "undo": "Back up N user turns and re-prompt (default 1)",
  "title": "Set a title for the current session",
  "handoff": "Hand off this session to a messaging platform (Telegram, Discord, etc.)",
  "branch": "Branch the current session (new thread on Discord/Telegram/Slack/Matrix; --here stays here)",
  "fork": "Branch the current session (new thread on Discord/Telegram/Slack/Matrix; --here stays here)",
  "worktree": "Show, list, create, or prune isolated git worktrees",
  "compress": "Compress conversation context (add 'here [N]' to keep recent N turns; --preview shows what would happen)",
  "compact": "Compress conversation context (add 'here [N]' to keep recent N turns; --preview shows what would happen)",
  "rollback": "List or restore filesystem checkpoints (restores keep your hand-edits; --all overrides)",
  "snapshot": "Create or restore state snapshots of Hermes config/state",
  "snap": "Create or restore state snapshots of Hermes config/state",
  "export": "Export a profile (config, skills, theme) to a shareable archive",
  "import": "Import a shared profile archive as a new profile",
  "stop": "Kill all running background processes",
  "bg": "Run a prompt in a separate background session",
  "btw": "Ask a side question about the current conversation without interrupting it",
  "tasks": "Show active agents and running tasks",
  "journey": "Open the learning journey timeline",
  "learning": "Open the learning journey timeline",
  "memory-graph": "Open the learning journey timeline",
  "queue": "Queue a prompt for the next turn, or list/edit/rm/move/clear queued prompts",
  "q": "Queue a prompt for the next turn, or list/edit/rm/move/clear queued prompts",
  "steer": "Inject a message after the next tool call without interrupting",
  "s": "Inject a message after the next tool call without interrupting",
  "goal": "Set a standing goal Hermes works on across turns until achieved",
  "heartbeat": "Set a recurring prompt that re-enters this session when idle",
  "hb": "Set a recurring prompt that re-enters this session when idle",
  "refine": "Review this conversation now and save lessons to memory/skills",
  "review": "Spawn an independent subagent to review the work just discussed (PR, code, docs)",
  "loop": "Re-run a prompt on a recurring interval in this session",
  "proactive": "Re-run a prompt on a recurring interval in this session",
  "plan": "Write a markdown implementation plan to .hermes/plans/ without executing anything",
  "moa": "Run one prompt through the default Mixture of Agents preset, then restore your model",
  "subgoal": "Add or manage extra criteria on the active goal",
  "status": "Show session, model, token, and context info",
  "egress": "Show Docker egress proxy status",
  "context": "Show detailed context window view with usage gauge, category breakdown, compression stats, and throughput",
  "ctx": "Show detailed context window view with usage gauge, category breakdown, compression stats, and throughput",
  "whoami": "Show your slash command access (admin / user)",
  "profile": "Show active profile name and home directory",
  "model": "Switch model (session-scoped; --global to persist)",
  "resume": "Resume a previously-named session",
  "sessions": "Browse and resume previous sessions",
  "config": "Show current configuration",
  "agents": "Show active agents and running tasks",
  "plugins": "List installed plugins and their status",
  "skills": "Search, install, inspect, or manage skills",
  "skin": "Show or change the display skin/theme",
  "codex-runtime": "Toggle codex app-server runtime for OpenAI/Codex models",
  "codex_runtime": "Toggle codex app-server runtime for OpenAI/Codex models",
  "personality": "Set a predefined personality",
  "statusbar": "Toggle the context/model status bar",
  "sb": "Toggle the context/model status bar",
  "battery": "Toggle a color-coded battery indicator in the status bar",
  "timestamps": "Toggle [HH:MM] timestamps on messages and /history",
  "ts": "Toggle [HH:MM] timestamps on messages and /history",
  "diff": "Show git changes in the working directory",
  "verbose": "Cycle tool progress display: off -> new -> all -> verbose",
  "focus": "Toggle focus view — show only your prompt and the final response",
  "footer": "Toggle gateway runtime-metadata footer on final replies",
  "yolo": "Toggle YOLO mode (skip all dangerous command approvals)",
  "approvals": "Show or set the persistent dangerous-command approval mode",
  "reasoning": "Manage reasoning effort and display",
  "fast": "Fast mode — OpenAI Priority Processing / Anthropic Fast Mode (normal/fast/auto/cold)",
  "indicator": "Pick the TUI busy-indicator style",
  "voice": "Toggle voice mode",
  "wake": "Toggle the 'Hey Hermes' wake word listener",
  "busy": "Control how messages behave while Hermes is working",
  "tools": "Manage tools: /tools [list|disable|enable] [name...]",
  "toolsets": "List available toolsets",
  "memory": "Review pending memory writes / toggle the approval gate",
  "bundles": "List skill bundles (aliases /<name> for multiple skills)",
  "pet": "Toggle or adopt a petdex mascot (/pet, /pet list, /pet <slug>)",
  "hatch": "Generate a new petdex pet from a description",
  "generate-pet": "Generate a new petdex pet from a description",
  "learn": "Learn a reusable skill from anything you describe (dirs, URLs, this chat, notes)",
  "init": "Generate or update AGENTS.md project instructions from a repo scan",
  "cron": "Manage scheduled tasks",
  "suggestions": "Review suggested automations (accept/dismiss)",
  "suggest": "Review suggested automations (accept/dismiss)",
  "blueprint": "Set up an automation from a blueprint template",
  "bp": "Set up an automation from a blueprint template",
  "curator": "Background skill maintenance (status, run, pin, archive, list-archived)",
  "kanban": "Multi-profile collaboration board (tasks, links, comments)",
  "reload": "Reload .env variables into the running session",
  "reload-mcp": "Reload MCP servers from config",
  "reload_mcp": "Reload MCP servers from config",
  "reload-skills": "Re-scan ~/.hermes/skills/ for newly installed or removed skills",
  "reload_skills": "Re-scan ~/.hermes/skills/ for newly installed or removed skills",
  "browser": "Connect browser tools to your live Chromium-family browser via CDP, or switch to Browser Use mode",
  "help": "Show available commands (/help skills lists skill commands, /help <text> filters)",
  "palette": "Open the fuzzy command palette (also Ctrl+P)",
  "usage": "Show token usage and rate limits; `reset` redeems a banked Codex limit reset",
  "subscription": "View your Nous plan and change it in the browser",
  "upgrade": "View your Nous plan and change it in the browser",
  "login": "Sign in with a Nous account (keeps your connectors)",
  "topup": "Show your Nous balance and manage billing on the portal",
  "insights": "Show usage insights and analytics",
  "platforms": "Show gateway/messaging platform status",
  "gateway": "Show gateway/messaging platform status",
  "copy": "Copy the last assistant response to clipboard",
  "paste": "Attach clipboard image from your clipboard",
  "image": "Attach a local image file for your next prompt",
  "update": "Update Hermes Agent to the latest version",
  "version": "Show Hermes Agent version",
  "v": "Show Hermes Agent version",
  "debug": "Upload debug report (system info + logs) and get shareable links",
  "quit": "Exit the CLI (use --delete to also remove session history)",
  "exit": "Exit the CLI (use --delete to also remove session history)",
};
const CORE_NAMES = new Set([...Object.keys(BUILTINS), "start", "topic", "pause", "approve", "deny", "agents", "tasks", "sethome", "set-home", "resume", "sessions", "config", "model", "skin", "skills", "plugins", "commands", "restart", "platform"]);
// The second line waits for a key at 354724fb: the reload-mcp and update confirmations (cli_info_mixin.py:908-923,
// cli_commands_mixin.py:2387-2407), undo's confirmation (cli_loops_mixin.py:220-242), prompt and compose open $EDITOR
// (cli_commands_mixin.py:2088-2131), palette its overlay, tasks (an alias of agents) and the journey views their TUI
// overlays, and the plan and billing commands their pickers whenever the account may change them (cli_billing_mixin.py).
// login shows its device code only on the screen, and debug uploads its report publicly as soon as it is typed.
const TERMINAL_BOUND = ["model", "resume", "sessions", "config", "agents", "plugins", "skills", "skin",
  "reload-mcp", "reload_mcp", "update", "undo", "prompt", "compose", "palette", "tasks", "journey", "learning", "memory-graph",
  "subscription", "upgrade", "topup", "login", "debug"] as const;
// new, reset and clear confirm first unless told now, --yes or -y (approvals.destructive_slash_confirm,
// cli_loops_mixin.py:93-100, 191-202); curator's destructive subcommands ask on a stdin the CLI does not read
const CONFIRMED: CommandForm[] = [
  { match: "bare", interaction: "terminal" },
  ...["now", "--yes", "-y"].map((sub): CommandForm => ({ match: { sub }, interaction: "none" })),
  { match: "other", interaction: "terminal" },
];
// printed inline by the classic CLI and read by the result readers in server/dialogs/hermes.ts
const RESULT_FORMS: Record<string, CommandForm[]> = {
  ...Object.fromEntries(
    [["help", "help"], ["status", "status"], ["version", "version"], ["v", "version"], ["profile", "profile"], ["reload-skills", "reload-skills"], ["reload_skills", "reload-skills"]]
      .map(([name, reader]) => [name, [{ match: "bare", interaction: "dialog", dialog: `hermes-${reader}` }]]),
  ),
  new: CONFIRMED, reset: CONFIRMED, clear: CONFIRMED,
  curator: [
    { match: "bare", interaction: "unknown" },
    ...["adopt", "prune", "purge", "rollback"].map((sub): CommandForm => ({ match: { sub }, interaction: "terminal" })),
    { match: "other", interaction: "unknown" },
  ],
};
const SKIP_DIRS = new Set([".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".venv", "venv", "node_modules", "site-packages", "__pycache__", ".tox", ".nox"]);
const SUPPORT_DIRS = new Set(["references", "templates", "assets", "scripts"]);

/** Hermes continues beneath a skill root, pruning only its support directories. */
function skillFiles(root: string): { path: string; fields: Readonly<Record<string, unknown>> }[] {
  const result: { path: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const ancestors = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    let entries: string[];
    try {
      canonical = realpathSync(directory);
      if (ancestors.has(canonical)) return;
      entries = readdirSync(directory).sort();
    } catch { return; }
    ancestors.add(canonical);
    const hasSkill = entries.includes("SKILL.md");
    if (hasSkill) {
      const path = join(directory, "SKILL.md");
      try {
        if (statSync(path).isFile()) result.push({ path, fields: readFrontmatter(path) ?? {} });
      } catch {}
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || (hasSkill && SUPPORT_DIRS.has(name))) continue;
      const path = join(directory, name);
      try { if (statSync(path).isDirectory()) visit(path); } catch {}
    }
    ancestors.delete(canonical);
  };
  visit(root);
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function yaml(path: string): Record<string, unknown> {
  try { return plainObject(Bun.YAML.parse(readFileSync(path, "utf8"))); }
  catch { return {}; }
}
function strings(value: unknown): string[] {
  if (typeof value === "string") {
    if (value.trim().startsWith("[")) {
      try { return strings(Bun.YAML.parse(value)); } catch { return [value]; }
    }
    return value.trim() ? [value.trim()] : [];
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean) : [];
}
/** Matches slugify_skill_name: underscores and spaces become hyphens; punctuation is removed. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[ _]/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
function projectRoot(cwd: string | null | undefined, home: string): string | null {
  if (!cwd) return null;
  let directory = canonical(cwd);
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(directory, ".git"))) return directory === canonical(home) ? null : directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function discover(ctx: AgentCommandContext): SlashCommand[] {
  // A Windows pane's environment cannot be read (no /proc), so its Hermes home would resolve under
  // <profile>\AppData\Local while transcripts use the server's %LOCALAPPDATA% (#2247): an unread one
  // takes only that variable from the server. Not HERMES_HOME: the server's profile is not the pane's.
  // a copy of the server's environment is a plain object, and Windows names are case-insensitive
  const serverLocalAppData = Object.entries(ctx.serverEnv ?? process.env).find(([key]) => key.toUpperCase() === "LOCALAPPDATA")?.[1];
  const environ = ctx.env ? environRecord(ctx.env) : serverLocalAppData ? { LOCALAPPDATA: serverLocalAppData } : {};
  const env = new Map(Object.entries(environ));
  const hermesHome = resolveHermesHome(ctx.home, environ);
  const expand = (entry: string): string => entry.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (token, braced: string | undefined, bare: string | undefined) => env.get(braced ?? bare ?? "") ?? token).replace(/^~(?=\/|$)/, ctx.home);
  const path = (entry: string): string => canonical(resolve(hermesHome, expand(entry)));
  // Only skills and quick_commands are consumed; no credentials or unrelated settings escape.
  const config = yaml(join(hermesHome, "config.yaml"));
  const settings = plainObject(config.skills);
  const root = projectRoot(ctx.cwd, ctx.home);
  const roots: { path: string; tier: number; origin: "project" | "user" }[] = [];
  if (root && settings.project_discovery !== false && strings(settings.trusted_project_dirs).some((entry) => canonical(resolve(expand(entry))) === root)) {
    for (const subdir of [".hermes", ".agents"]) roots.push({ path: join(root, subdir, "skills"), tier: 0, origin: "project" });
  }
  const local = canonical(join(hermesHome, "skills"));
  roots.push({ path: local, tier: 1, origin: "user" });
  if (typeof settings.create_dir === "string" && settings.create_dir.trim()) roots.push({ path: path(settings.create_dir), tier: 2, origin: "user" });
  for (const entry of strings(settings.external_dirs)) roots.push({ path: path(entry), tier: 3, origin: "user" });
  const disabled = new Set(strings(settings.disabled));
  disabled.delete("hermes-agent");
  const bundled = new Set(skillFiles(join(platformHermesHome(ctx.home, environ), "hermes-agent", "skills")).map((skill) => slug(typeof skill.fields.name === "string" ? skill.fields.name : basename(dirname(skill.path)))));
  const entries = new Map<string, { tier: number; root: string; origin: "project" | "user"; path: string; description: string }[]>();
  const seenRoots = new Set<string>();
  for (const directory of roots) {
    const directoryPath = canonical(directory.path);
    if (seenRoots.has(directoryPath)) continue;
    seenRoots.add(directoryPath);
    for (const skill of skillFiles(directoryPath)) {
      const name = typeof skill.fields.name === "string" ? skill.fields.name : basename(dirname(skill.path));
      const platforms = strings(skill.fields.platforms);
      const platformMap: Record<string, string> = { macos: "darwin", linux: "linux", windows: "win32" };
      if (platforms.length && !platforms.some((value) => process.platform.startsWith(platformMap[value.toLowerCase()] ?? value.toLowerCase()))) continue;
      let description = typeof skill.fields.description === "string" ? skill.fields.description.trim() : "";
      if (!description) {
        try {
          const body = readSkillText(skill.path).replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/, "");
          description = body.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#"))?.trim().slice(0, 80) ?? "";
        } catch { continue; }
      }
      const previous = entries.get(name) ?? [];
      previous.push({ tier: directory.tier, root: directoryPath, origin: directory.origin, path: skill.path, description: description || `Invoke the ${name} skill` });
      entries.set(name, previous);
    }
  }
  const commands = new Map<string, SlashCommand>();
  for (const [name, candidates] of entries) {
    const topTier = Math.min(...candidates.map((entry) => entry.tier));
    const contenders = candidates.filter((entry) => entry.tier === topTier);
    const first = contenders[0];
    if (!first) continue;
    if (contenders.length > 1) {
      if (!contenders.every((entry) => entry.root === first.root && readFileSync(entry.path, "utf8") === readFileSync(first.path, "utf8"))) continue;
      contenders.sort((left, right) => relative(left.root, left.path).split(/[\\/]/).length - relative(right.root, right.path).split(/[\\/]/).length);
      const [best, next] = contenders;
      if (best && next && relative(best.root, best.path).split(/[\\/]/).length === relative(next.root, next.path).split(/[\\/]/).length) continue;
    }
    const winner = contenders[0];
    if (!winner || disabled.has(name)) continue;
    const key = slug(name);
    if (!key || CORE_NAMES.has(key) || commands.has(key)) continue;
    commands.set(key, { name: key, description: winner.description, source: "skill", origin: winner.root === local && bundled.has(key) ? "bundled" : winner.origin, id: canonical(winner.path) });
  }
  const bundlesDir = env.get("HERMES_BUNDLES_DIR") ? expand(env.get("HERMES_BUNDLES_DIR") ?? "") : join(hermesHome, "skill-bundles");
  const bundleNames = new Set<string>();
  if (existsSync(bundlesDir)) {
    const files = readdirSync(bundlesDir).sort();
    for (const extension of [".yaml", ".yml"]) for (const file of files.filter((file) => file.endsWith(extension))) {
      const bundle = yaml(join(bundlesDir, file));
      if (!Array.isArray(bundle.skills)) continue;
      const members = strings(bundle.skills);
      const name = slug(typeof bundle.name === "string" && bundle.name.trim() ? bundle.name : file.slice(0, -extension.length));
      if (!members.length || !name || CORE_NAMES.has(name) || bundleNames.has(name)) continue;
      bundleNames.add(name);
      commands.set(name, { name, description: typeof bundle.description === "string" && bundle.description.trim() ? bundle.description.trim() : `Load ${members.length} skills as a bundle`, source: "skill", origin: "user" });
    }
  }
  for (const [name, value] of Object.entries(plainObject(config.quick_commands))) {
    if (!name || CORE_NAMES.has(name)) continue;
    const command = plainObject(value);
    commands.set(name, { name, description: typeof command.description === "string" ? command.description : `Run /${name}`, source: "user" });
  }
  // Hermes plugin manifests have no command field; commands.py parses fields only, while plugins.py
  // registers slash commands at runtime (354724fb085162678964c116ceb4c40fc57c717c,
  // plugins_manifest.py:32-39,342-395,544-557; plugins.py:647-671).
  return [...commands.values()];
}

export const source: AgentCommandSource = {
  builtins: Object.keys(BUILTINS),
  chatPaletteHidden: ["approvals", "reasoning", "yolo"],
  descriptions: BUILTINS,
  forms: RESULT_FORMS,
  terminalBound: TERMINAL_BOUND,
  pin: "0.21.5",
  discover,
};
