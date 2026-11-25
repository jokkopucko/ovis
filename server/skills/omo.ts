import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { environValue, parseJsonc, plainObject, readSkillText, walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

/** Catalog inputs: Senpi 46d15a1c93551df9a879125d4d4235010434a639 and OmO senpi b6230fcd621f35f6f504883067d889d6f13b4d8e. */
const OMO_DESCRIPTIONS: Record<string, string> = {
  settings: "Theme, message delivery, transport, and other preferences",
  model: "Switch this session's model; Ctrl+S in the picker, or /model <id> --default, also makes it the startup default",
  thinking: "Switch thinking level; Ctrl+S in the picker saves the startup default",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", "favorite-models": "Manage favorite models for Ctrl+P cycling",
  export: "Export session to HTML or JSONL file", import: "Import and resume a session from a JSONL file",
  share: "Upload as private GitHub gist with shareable HTML link", copy: "Copy last assistant message to clipboard",
  rename: "Rename the current session (`/name` is an alias)", name: "Rename the current session (`/name` is an alias)",
  session: "Show session info (file, ID, messages, tokens, cost)",
  changelog: "Display version history", hotkeys: "Show all keyboard shortcuts", fork: "Create a new session from a previous user message",
  clone: "Duplicate the current active branch into a new session", trust: "Save project trust decision for future sessions (restart required)",
  login: "Manage provider credentials", logout: "Manage provider credentials", new: "Start a new session",
  compact: "Manually compact context, optional custom instructions", resume: "Pick from previous sessions",
  sessions: "Alias of /resume (browse and resume past sessions)",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", quit: "Quit omo", exit: "Quit omo",
  tasks: "List session tasks (--all for every session).", dag: "List dag runs, or show one run's wave tree.",
  doctor: "Run deterministic memory health checks and repair skill frontmatter.",
  facts: "Show facts-extraction queue/backoff state, or manually retry parked batches.",
  memory: "View committed memory: HEAD, system bodies, external names, and uncommitted changes; unlock re-checks and removes a stranded git lock.",
  people: "Show the people roster and relationship graph, one person's record, or ask about them.",
  search: "Search past session transcripts and show scored, numbered results.",
  "task-kill": "Cancel a session task via selector.",
  computer: "Computer use (experimental): on, off, status, stop, or resume (stop and resume are user-only)",
  dream: "Request a manual multi-conversation memory dream run.",
  init: "Initialize the memory repository and instruct the agent to create initial memory.",
  memfs: "Inspect and maintain the memory filesystem repository.",
  "memory-repository": "Configure the push-only mirror remote for the memory repository.",
  recompile: "Recompile the memory block into the system prompt on the next agent run.",
  reflect: "Request a memory reflection run now, optionally scoped and focused.",
  remember: "Persist text to long-term memory via a memory-tool turn.",
  sleeptime: "Show the resolved sleeptime memory settings for this identity.",
  palace: "Generate the memory palace HTML viewer for the bound identity.",
  help: "Show usage, keybindings, and all commands",
  keybindings: "Open your keybindings.json in $EDITOR and reload it live",
  history: "Search prompt history across sessions", files: "Show files read/written/edited in this session",
  diff: "Show git changes and open in VS Code diff view",
  lookat: "View and manage the current-session look_at vision model chain.",
  account: "List and manage credential accounts for any provider.",
  "claude-account": "List and manage Anthropic Subscription accounts.",
  "cursor-account": "List and manage Cursor CLI (OAuth) accounts.",
  "gpt-account": "List and manage ChatGPT Subscription OAuth accounts.",
  efforts: "Show or set the reasoning effort for the current model",
  answer: "Open the pending question",
  goal: "Set, inspect, pause, resume, or clear the persistent goal",
  loop: "Repeat a prompt on a fixed interval or a self-paced schedule (e.g. /loop 5m check the deploy)",
  mcp: "Inspect and manage MCP servers.",
  fallback: "View and manage retry model fallback chains.",
  reasoning: "Show or toggle reasoning for the current model",
  rules: "Inspect loaded pi-rules.", "reload-rules": "Reload pi-rules for the current session.",
  fast: "Turn ChatGPT Subscription fast mode on or off for the current model",
  todo: "Show or edit the todo list (edit/copy/export/import/append/start/done/drop/rm)",
  ttsr: "Show TTSR stream-rule status: builtin detectors, user rules, injected rules.",
  websearch: "Show web search provider status",
  ir: "Import a CI issue-analysis session from a gist ID, share URL, or issue URL and switch to it",
  "nested-agents": "Toggle the nested AGENTS.md context widget and dump cache state.",
  tui: "Show TUI stats",
  btw: "Ask a side question in parallel without touching the main session",
  tree: "Jump to any point in the session and continue from there",
};

const pluginCommands = [
  "tasks", "dag", "doctor", "facts", "memory", "people", "search", "task-kill", "computer", "dream",
  "init", "memfs", "memory-repository", "recompile", "reflect", "remember", "sleeptime", "palace",
  "help", "keybindings", "history", "files", "diff", "lookat", "account", "claude-account", "cursor-account",
  "gpt-account", "efforts", "answer", "goal", "loop", "mcp", "fallback", "reasoning", "rules",
  "reload-rules", "fast", "todo", "ttsr", "websearch", "ir", "nested-agents", "tui", "btw",
] as const;

const pluginTerminalCommands = ["tasks", "dag", "btw"] as const;

// The second line holds the Senpi selectors that wait for a key: share and trust (modes/interactive/interactive-mode.js 8090, 6916).
const terminalCommands = [
  "settings", "tree", "thinking", "scoped-models", "favorite-models", "login", "logout", "fork", "resume", "sessions",
  "share", "trust",
] as const;

const terminalForm = [{ match: "bare", interaction: "terminal" }] as const;

function omoSkills(root: string, mode: "pi" | "agents", origin: NonNullable<SlashCommand["origin"]>, disabled: ReadonlySet<string> = new Set()): SlashCommand[] {
  return walkSkills(root, { depth: "recursive", looseMarkdown: mode === "pi" ? "root" : "nested", ignoreFiles: true, requireDescription: true })
    .filter(({ path }) => origin !== "bundled" || !disabled.has(basename(dirname(path))))
    .map(({ name, description, id }) => ({ name: `skill:${name}`, description, source: "skill", origin, id }));
}

function realpathOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function isSymlink(path: string): boolean {
  if (!existsSync(path)) return false;
  try { return lstatSync(path).isSymbolicLink(); } catch { return true; }
}

/** Project config path rules match pinned omo-config-core loader/paths.ts. */
function projectConfigPaths(cwd: string | null | undefined, home: string): string[] {
  if (!cwd) return [];
  const boundaries = [...new Set([resolve(home), resolve(homedir())])];
  const realBoundaries = new Set(boundaries.map(realpathOrSelf));
  const paths: string[] = [];
  let directory = resolve(cwd);
  for (let depth = 0; depth < 256; depth++) {
    const atHome = boundaries.includes(directory) || realBoundaries.has(realpathOrSelf(directory));
    if (!atHome) {
      const configDirectory = join(directory, ".omo");
      if (!isSymlink(configDirectory)) {
        const jsonc = join(configDirectory, "omo.jsonc");
        const json = join(configDirectory, "omo.json");
        const candidate = existsSync(jsonc) && !isSymlink(jsonc)
          ? jsonc
          : existsSync(json) && !isSymlink(json) ? json : undefined;
        if (candidate) paths.push(candidate);
      }
    }
    if (atHome) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return paths.reverse();
}

/** Mirrors OmO config paths, profile selection and harness union at oh-my-openagent b6230fcd. */
function disabledSkills(home: string, cwd: string | null | undefined, env: readonly string[] | null | undefined): ReadonlySet<string> {
  const disabled = new Set<string>();
  const load = (path: string): Record<string, unknown> => {
    try {
      // bounded and regular files only: project configs are looked up above the pane's folder
      return plainObject(parseJsonc(readSkillText(path)));
    } catch { return {}; /* upstream drops a source layer on read or parse errors */ }
  };
  const configPath = (directory: string): string => {
    const jsonc = join(directory, ".omo", "omo.jsonc");
    return existsSync(jsonc) ? jsonc : join(directory, ".omo", "omo.json");
  };
  const configs = [
    load(configPath(home)),
    ...projectConfigPaths(cwd, home).map(load),
  ];
  const openCodeConfigDir = environValue(env, "OPENCODE_CONFIG_DIR");
  const openCodeProfile = openCodeConfigDir?.match(/(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]*$/)?.[1];
  const activeProfile = environValue(env, "OMO_PROFILE") || environValue(env, "OCX_PROFILE") || openCodeProfile;
  for (const config of configs) {
    const profile = activeProfile ? plainObject(plainObject(config.profiles)[activeProfile]) : {};
    // [senpi] is the legacy alias for [native]; upstream unions both spellings.
    for (const scope of [config, plainObject(config["[native]"]), plainObject(config["[senpi]"]), profile, plainObject(profile["[native]"]), plainObject(profile["[senpi]"])]) {
      const names = scope.disabled_skills;
      if (Array.isArray(names)) for (const name of names) if (typeof name === "string" && name.trim()) disabled.add(name.trim());
    }
  }
  return disabled;
}

export const source: AgentCommandSource = {
  builtins: ["settings", "model", "thinking", "scoped-models", "favorite-models", "export", "import", "share", "copy", "rename", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "sessions", "reload", "quit", "exit"],
  descriptions: OMO_DESCRIPTIONS,
  chatPaletteHidden: ["efforts", "reasoning"],
  pin: "2026.10.19",
  forms: {
    model: [{ match: "bare", interaction: "dialog", dialog: "omo-model" }],
    tasks: [...terminalForm], dag: [...terminalForm], btw: [...terminalForm],
    settings: [...terminalForm], tree: [...terminalForm], thinking: [...terminalForm],
    "scoped-models": [...terminalForm], "favorite-models": [...terminalForm],
    login: [...terminalForm], logout: [...terminalForm], fork: [...terminalForm],
    resume: [...terminalForm], sessions: [...terminalForm],
    share: [...terminalForm], trust: [...terminalForm],
    // bare /import prints its usage; /import <path> asks "Replace current session with …?" (interactive-mode.js 8034-8040)
    import: [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "terminal" }],
    // bare opens an inline "Rename session" text input; given a name it is stored in the session (interactive-mode.js 8173-8194)
    rename: [...terminalForm, { match: "other", interaction: "none" }], name: [...terminalForm, { match: "other", interaction: "none" }],
  },
  terminalBound: terminalCommands,
  discover({ home, cwd, env, roots }) {
    const disabled = disabledSkills(home, cwd, env);
    return [
      ...pluginCommands.map((name) => ({
        name,
        description: OMO_DESCRIPTIONS[name] ?? `Run /${name}`,
        source: "builtin" as const,
        id: name,
        forms: source.forms?.[name],
        visibility: pluginTerminalCommands.includes(name as typeof pluginTerminalCommands[number]) ? "terminal" as const : "offered" as const,
        provenance: { transport: "static" as const, verified: false },
      })),
      ...omoSkills(join(roots.agentDir ?? join(home, ".omo", "agent"), "skills"), "pi", "user"),
      ...omoSkills(join(home, ".agents", "skills"), "agents", "user"),
      ...(roots.pluginDir ? omoSkills(join(roots.pluginDir, "skills"), "pi", "bundled", disabled) : []),
    ];
  },
};
