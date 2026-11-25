import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep, win32 } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, environRecord, environValue, MAX_WALK_FOLDERS, piTemplates, plainObject, readFrontmatter, readSkillText } from "./walk.ts";

/**
 * Pinned to codex-rs at 83086188ae0614bd882818ff1aa23f3194962012 (rust-v0.163.0 for the slash table):
 * - skills load recursively to MAX_SCAN_DEPTH 6, following directory links, skipping dot directories
 *   (ext/skills/src/loader/discovery.rs); a SKILL.md reached through a link is not loaded;
 * - a missing or blank `name` falls back to the directory name (skills/src/parser.rs:63-69);
 * - the roots are the project `.codex/skills` of each ancestor, $CODEX_HOME/skills, ~/.agents/skills,
 *   the system cache and the admin directory (ext/skills/src/host_roots.rs:88-101);
 * - a plugin skill is qualified `namespace:name` with the plugin manifest's name
 *   (ext/skills/src/loader/namespace.rs:167-183, utils/plugins/src/plugin_namespace.rs);
 * - custom prompts were removed in rust-v0.118.0 (https://github.com/openai/codex/releases/tag/rust-v0.118.0).
 */
const MAX_SCAN_DEPTH = 6;
const PROMPTS_REMOVED_IN = [0, 118, 0] as const;
// utils/plugins/src/plugin_namespace.rs: the manifest locations a plugin root may carry
const MANIFESTS = ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"];

function canonical(path: string): string {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

/** Custom prompts are offered only by a Codex known to be older than 0.118.0. */
function offersPrompts(version: string | null | undefined): boolean {
  const parts = version?.match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return false;
  for (const [index, limit] of PROMPTS_REMOVED_IN.entries()) {
    if (parts[index]! !== limit) return parts[index]! < limit;
  }
  return false;
}

/** The machine-wide skills root: %ProgramData%\\OpenAI\\Codex\\skills on Windows, /etc/codex/skills elsewhere. */
export function adminSkillsRoot(platform: string, env: readonly string[] | null, programData: string | undefined): string | null {
  if (platform !== "win32") return "/etc/codex/skills";
  const base = Object.entries(environRecord(env)).find(([key]) => key.toLowerCase() === "programdata")?.[1] || programData;
  return base ? win32.join(base, "OpenAI", "Codex", "skills") : null;
}

function manifestName(root: string): string | null {
  for (const manifest of MANIFESTS) {
    try {
      // bounded and regular files only: the walk climbs above the skill roots, where a FIFO named
      // like a manifest would otherwise block the server
      const fields = plainObject(JSON.parse(readSkillText(join(root, manifest))));
      // a root plugin.json counts only when it carries no foreign $schema (plugin_namespace.rs)
      if (manifest === "plugin.json" && !(typeof fields.$schema === "string" && fields.$schema.startsWith("https://agent-plugins.org/schemas/"))) continue;
      return typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : basename(root);
    } catch {}
  }
  return null;
}

interface FoundSkill { readonly name: string; readonly description: string; readonly path: string }

/**
 * SKILL.md files under `root`, to depth 6; `ancestors` guards link cycles along one branch only, so
 * sibling links to one folder multiply the paths: every folder resolved counts against `budget`, which
 * the roots of one discovery share (walk.ts MAX_WALK_FOLDERS).
 */
function scanSkills(root: string, budget: { folders: number }): FoundSkill[] {
  const found: FoundSkill[] = [];
  const ancestors = new Set<string>();
  const visit = (directory: string, depth: number): void => {
    if (budget.folders <= 0) return;
    budget.folders -= 1;
    let real: string;
    try { real = realpathSync(directory); } catch { return; }
    if (ancestors.has(real)) return;
    ancestors.add(real);
    try {
      const declared = join(directory, "SKILL.md");
      try {
        // a SKILL.md that is itself a link is not followed; a linked directory is
        if (lstatSync(declared).isFile()) {
          const fields = readFrontmatter(declared);
          const description = typeof fields?.description === "string" ? fields.description.replace(/\s+/g, " ").trim() : "";
          const named = typeof fields?.name === "string" ? fields.name.replace(/\s+/g, " ").trim() : "";
          if (description) found.push({ name: named || basename(directory), description, path: declared });
        }
      } catch {}
      if (depth >= MAX_SCAN_DEPTH) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const child = join(directory, entry.name);
        try { if (statSync(child).isDirectory()) visit(child, depth + 1); }
        catch {}
      }
    } catch {}
    finally { ancestors.delete(real); }
  };
  visit(root, 0);
  return found;
}

const TERMINAL: CommandForm[] = [{ match: "bare", interaction: "terminal" }];
const NONE: CommandForm[] = [{ match: "bare", interaction: "none" }];

export const source: AgentCommandSource = {
  chatPaletteHidden: ["plan"],
  // codex-rs/tui/src/slash_command.rs at rust-v0.163.0, in its presentation order. Not listed: `app` (macOS and
  // Windows builds only) and `rollout` and `test-approval` (debug builds). `fast` is a model service-tier command
  // there, not a built-in. What the popup hides is listed again in `agentHidden`.
  builtins: ["model", "daybreak", "ide", "permissions", "keymap", "vim", "setup-default-sandbox", "experimental", "approve",
    "memories", "skills", "import", "hooks", "review", "rename", "new", "archive", "delete", "resume", "fork", "worktree",
    "init", "compact", "config", "recap", "plan", "voice", "goal", "agents", "side", "btw", "copy", "export", "raw", "tui",
    "diff", "mention", "status", "daemon", "warnings", "cd", "pwd", "usage", "title", "statusline", "theme", "pets", "mcp",
    "apps", "plugins", "logout", "quit", "exit", "feedback", "ps", "stop", "clear", "subagents", "debug-config", "debug-m-drop", "debug-m-update"],
  descriptions: {
    model: "Choose what model and reasoning effort to use", daybreak: "Turn Daybreak on or off", config: "Configure Codex preferences", apps: "Manage apps", "debug-config": "Show config layers and requirement sources for debugging",
    "debug-m-drop": "DO NOT USE", "debug-m-update": "DO NOT USE",
    "setup-default-sandbox": "Set up elevated agent sandbox", btw: "Start a side conversation in an ephemeral fork", quit: "Exit Codex",
    ide: "Include current selection, open files, and other context from your IDE",
    keymap: "Remap TUI shortcuts", vim: "Toggle Vim mode for the composer",
    experimental: "Toggle experimental features", approve: "Approve one retry of a recent auto-review denial",
    memories: "Configure memory use and generation", import: "Import setup, this project, and recent chats from Claude Code",
    review: "Review my current changes and find issues", rename: "Rename the current thread",
    new: "Start a new chat during a conversation", archive: "Archive this session",
    delete: "Permanently delete this session", fork: "Fork the current chat",
    worktree: "Start or continue a conversation in a new worktree", init: "Create an AGENTS.md file with instructions for Codex",
    compact: "Summarize conversation to prevent hitting the context limit", recap: "Summarize the current conversation now",
    plan: "Switch to Plan mode", goal: "Set or view the goal for a long-running task",
    side: "Start a side conversation in an ephemeral fork", copy: "Copy the last response or part of it",
    export: "Export the conversation as markdown", raw: "Toggle raw scrollback mode for copy-friendly terminal selection",
    tui: "Choose the TUI mode for the next launch", diff: "Show git diff (including untracked files)",
    mention: "Mention a file", status: "Show current session configuration and token usage",
    daemon: "Manage the local background server", warnings: "View retained warnings and diagnostic details",
    cd: "Change the current working directory", pwd: "Show the current working directory",
    usage: "View account usage or use a usage limit reset", title: "Configure which items appear in the terminal title",
    statusline: "Configure which items appear in the status line", pets: "Choose or hide the terminal pet",
    logout: "Log out of Codex", exit: "Exit Codex", feedback: "Send logs to maintainers",
    ps: "List background terminals", stop: "Stop all background terminals",
    clear: "Clear the terminal and start a new chat", subagents: "Switch between this session's subagents",
    resume: "Resume a saved chat", permissions: "Choose what Codex is allowed to do", agents: "Open the agent command center",
    hooks: "View and manage lifecycle hooks", mcp: "List MCP tools; use /mcp verbose or /mcp login <name>",
    plugins: "Browse plugins", skills: "Use skills to improve how Codex performs specific tasks", voice: "Start or stop voice; use /voice settings to choose a voice",
    theme: "Choose a syntax highlighting theme",
  },
  // codex-rs/tui/src/slash_command.rs at rust-v0.163.0: only these show something Chat can persist or open
  forms: {
    model: [{ match: "bare", interaction: "dialog", dialog: "codex-model" }],
    status: TERMINAL, diff: TERMINAL, pwd: TERMINAL, ps: TERMINAL, mcp: TERMINAL,
    init: NONE, compact: NONE,
    // bare /review opens the "Select a review preset" popup (chatwidget/slash_dispatch.rs:361-367, review_popups.rs:15-65);
    // /review <text> submits a custom review as a turn (slash_dispatch.rs:1092-1093)
    review: [...TERMINAL, { match: "other", interaction: "none" }],
    // bare opens a text prompt or an export picker; given a name or a path they act and return
    // (chatwidget/interaction.rs:450-493, transcript_export.rs:8-45, slash_dispatch.rs:807-815, 894-905)
    rename: [...TERMINAL, { match: "other", interaction: "none" }],
    export: [...TERMINAL, { match: "other", interaction: "none" }],
    // `/goal edit` opens a text prompt (slash_dispatch.rs:968-1073)
    goal: [{ match: "bare", interaction: "unknown" }, { match: { sub: "edit" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  },
  // the nine names this scanner used to leave out, and the other screens only the TUI can draw. The second
  // group holds a picker, view, confirmation or prompt whatever follows the name: /new and /fork ask where to
  // run inside a git repository (worktree_picker.rs:16-85), /cd asks to trust a folder it has not seen
  // (app/working_directory.rs:263-290), /side and /btw move the TUI into an ephemeral thread (app/side.rs),
  // /mention leaves "@" and the file search in the composer, /vim leaves the composer in Normal mode
  // (bottom_pane/textarea.rs:316-326), and /logout signs out and exits
  terminalBound: ["resume", "permissions", "agents", "hooks", "mcp", "plugins", "skills", "voice", "theme", "config", "setup-default-sandbox",
    "keymap", "experimental", "approve", "memories", "import", "new", "archive", "delete", "fork", "worktree", "side", "btw", "copy", "tui",
    "mention", "daemon", "warnings", "cd", "usage", "title", "statusline", "pets", "feedback", "subagents", "vim", "logout"],
  // the popup builds without `apps` and every `debug*` command (bottom_pane/command_popup.rs:91-93); typed by hand they still dispatch
  agentHidden: ["apps", "debug-config", "debug-m-drop", "debug-m-update"],
  pin: "0.163.0",
  discover({ home, cwd, env, version, serverEnv = process.env }) {
    const codexHome = environValue(env, "CODEX_HOME") || join(home, ".codex");
    let config: Record<string, unknown> = {};
    try { config = plainObject(Bun.TOML.parse(readFileSync(join(codexHome, "config.toml"), "utf8"))); }
    catch { /* missing or malformed TOML leaves discovery ungated */ }
    const configured = plainObject(config.skills).config;
    const disabled = new Set((Array.isArray(configured) ? configured : []).flatMap((entry: unknown) => {
      const setting = plainObject(entry);
      return setting.enabled === false && typeof setting.path === "string" ? [canonical(setting.path)] : [];
    }));
    const result: SlashCommand[] = offersPrompts(version)
      ? piTemplates(join(codexHome, "prompts"), "user").map((command) => ({ ...command, name: `prompts:${command.name}` }))
      : [];
    const seen = new Set<string>();
    // ext/skills/src/loader/namespace.rs: a skill takes the namespace of the nearest plugin manifest at or
    // above its directory, in every root; `fallback` names a cached plugin whose manifest is missing
    const namespaces = new Map<string, string | null>();
    const namespaceAt = (directory: string): string | null => {
      const known = namespaces.get(directory);
      if (known !== undefined) return known;
      const parent = dirname(directory);
      const found = manifestName(directory) ?? (parent === directory ? null : namespaceAt(parent));
      namespaces.set(directory, found);
      return found;
    };
    const budget = { folders: MAX_WALK_FOLDERS };
    const load = (root: string, origin: SlashCommand["origin"], fallback?: string): void => {
      for (const skill of scanSkills(root, budget)) {
        const id = canonical(skill.path);
        if (disabled.has(id) || seen.has(id)) continue;
        seen.add(id);
        const namespace = namespaceAt(dirname(id)) ?? fallback;
        result.push({ name: namespace ? `${namespace}:${skill.name}` : skill.name, description: skill.description, source: "skill", trigger: "$", origin, id });
      }
    };
    for (const directory of cwd ? ancestorsToRepoRoot(cwd, home) : []) {
      load(join(directory, ".agents", "skills"), "project");
      load(join(directory, ".codex", "skills"), "project");
    }
    load(join(home, ".agents", "skills"), "user");
    load(join(codexHome, "skills"), "user");
    load(join(codexHome, "skills", ".system"), "bundled");
    const admin = adminSkillsRoot(process.platform, env, serverEnv["ProgramData"]);
    if (admin) load(admin, "bundled");

    const cache = join(codexHome, "plugins", "cache");
    const plugins = config.plugins === undefined ? null : plainObject(config.plugins);
    const ancestors = new Set<string>();
    // A version's `latest` link and the version itself are one plugin install, loaded once.
    const loaded = new Set<string>();
    const visit = (directory: string): void => {
      let path: string;
      try { path = realpathSync(directory); } catch { return; }
      if (ancestors.has(path)) return;
      ancestors.add(path);
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const child = join(directory, entry.name);
          try { if (!statSync(child).isDirectory()) continue; }
          catch { continue; }
          if (entry.name === "skills") {
            if (loaded.has(canonical(child))) continue;
            loaded.add(canonical(child));
            const parts = relative(cache, directory).split(sep);
            const enabled = plugins === null || Object.entries(plugins).some(([key, value]) => {
              const [plugin, marketplace] = key.split("@");
              return plainObject(value).enabled === true && (parts[0] === key || parts[0] === plugin
                || (parts[0] === marketplace && parts[1] === plugin));
            });
            if (enabled) load(child, "plugin", (parts.length > 2 ? parts[1] : parts[0]) ?? basename(directory));
          } else if (!entry.name.startsWith(".")) visit(child);
        }
      } catch {}
      finally { ancestors.delete(path); }
    };
    visit(cache);
    return result;
  },
};
