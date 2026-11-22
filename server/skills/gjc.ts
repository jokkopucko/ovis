import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { ancestorsToRepoRoot, description, environRecord, walkSkills } from "./walk.ts";

// From GJC's builtin-registry.ts at e9179a14cb19d0f34e0da199f10f89793ddac60a (v0.18.12).
// TUI-only commands come from handleTui registry entries; /tree is likewise TUI-local.
const DESCRIPTIONS = {
  aside: "Run the Aside CLI from the composer",
  "import-session": "Import a Codex or Claude transcript into native GJC history",
  notify: "Notification status, health, test, recovery, and session on/off",
  settings: "Open settings and preferences",
  language: "Change the interactive UI language, or show the current one",
  theme: "Change theme immediately, or open the theme selector without args",
  pet: "Gajae pet living beside the composer",
  goal: "Plan and track an autonomous goal",
  model: "Select model (opens selector UI)",
  effort: "Show or set model reasoning effort",
  fast: "Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast)",
  routing: "Show or set up sub-agent model autorouting",
  export: "Export this session to an HTML file",
  copy: "Copy the last response for review or sharing",
  dump: "Dump the full transcript for review or sharing",
  session: "Show session info or delete the current session transcript/artifacts",
  jobs: "Show async background jobs status",
  transcript: "Browse the current session transcript",
  context: "Show active context token usage breakdown",
  progress: "Show a read-only project progress overview from durable goal, todo, workflow, agent, and verification state",
  usage: "Show provider usage and limits",
  credential: "Switch this session's active stored account, or list accounts",
  changelog: "Show release notes and changelog entries",
  tutorial: "Open frictionless onboarding",
  help: "Learn commands and beginner workflows",
  hotkeys: "Show all keyboard shortcuts",
  tools: "Show tools currently visible to the agent",
  mcp: "Show MCP server status for this session",
  agents: "Open Agent Control Center dashboard",
  extensions: "Configure skills, hooks, and MCPs.",
  monitors: "Open the monitor/cron jobs overlay",
  tree: "Navigate session tree (switch branches)",
  fork: "Choose an earlier prompt to continue in a new session",
  provider: "Show provider credential status or set up providers",
  login: "Login with OAuth provider",
  logout: "Logout from OAuth provider",
  ssh: "Manage SSH hosts (add, list, remove)",
  clear: "Clear context while preserving this session ID",
  new: "Start a new session",
  star: "Star the current session for easier discovery",
  unstar: "Remove the star from the current session",
  drop: "Delete the current session and start a new one",
  compact: "Compact context and continue this session",
  handoff: "Generate a handoff and continue in a new session",
  "contribute-pr": "Dump redacted session context and write a worker prompt for a separate terminal",
  resume: "Resume a previous session",
  sessions: "Show all persisted sessions (read-only)",
  btw: "Start an ephemeral multi-turn side chat using the current session context",
  retry: "Retry or continue the last interrupted turn",
  background: "Detach UI and continue running in background",
  debug: "Open debug tools selector",
  memory: "Inspect and operate memory maintenance",
  rename: "Rename the current session, or regenerate the title from the conversation",
  move: "Move session to a different working directory",
  exit: "Exit the application",
} as const;

const TERMINAL_BOUND = ["tree"] as const;
const TERMINAL_FORMS = [
  "settings", "language", "theme", "pet", "goal", "copy", "tutorial", "help", "hotkeys", "mcp", "agents",
  "extensions", "monitors", "tree", "fork", "login", "logout", "new", "drop", "resume", "sessions", "btw",
  "retry", "background", "debug", "exit",
  // the transcript viewer overlay (slash-commands/builtin-registry.ts:1577-1581)
  "transcript",
] as const;
const FORMS: NonNullable<AgentCommandSource["forms"]> = Object.fromEntries([
  ...TERMINAL_FORMS.map((name) => [name, [{ match: "bare" as const, interaction: "terminal" as const }]]),
  ["model", [
    { match: "bare" as const, interaction: "dialog" as const, dialog: "fallback-gjc-menu" },
    { match: "other" as const, interaction: "none" as const },
  ]],
  ["effort", [
    { match: "bare" as const, interaction: "dialog" as const, dialog: "fallback-gjc-menu" },
    { match: "other" as const, interaction: "none" as const },
  ]],
  ["handoff", [{ match: "bare" as const, interaction: "none" as const }]],
  // bare opens a model selector or the provider onboarding selector, `/provider login` the OAuth selector and
  // `/session delete` a confirmation (builtin-registry.ts:1358-1384, 1979-2043; modes/controllers/selector-controller.ts:3681-3697)
  ["routing", [
    { match: "bare" as const, interaction: "terminal" as const },
    { match: "other" as const, interaction: "none" as const },
  ]],
  ["provider", [
    { match: "bare" as const, interaction: "terminal" as const },
    { match: { sub: "login" }, interaction: "terminal" as const },
    { match: "other" as const, interaction: "unknown" as const },
  ]],
  ["session", [
    { match: "bare" as const, interaction: "unknown" as const },
    { match: { sub: "delete" }, interaction: "terminal" as const },
    { match: "other" as const, interaction: "unknown" as const },
  ]],
]);

// Match the pinned interactive registry: utility rows are quarantined, and
// import-session is offered only where its retained-descriptor authority exists.
function activeBuiltin(name: string): boolean {
  return name !== "agents" && (name !== "import-session" || process.platform === "linux");
}
const ACTIVE_BUILTINS = Object.keys(DESCRIPTIONS).filter(activeBuiltin);
const ACTIVE_DESCRIPTIONS = Object.fromEntries(
  ACTIVE_BUILTINS.map((name) => [name, DESCRIPTIONS[name as keyof typeof DESCRIPTIONS]]),
);
const ACTIVE_FORMS = Object.fromEntries(Object.entries(FORMS).filter(([name]) => activeBuiltin(name)));

// Descriptions read from the installed binary's embedded SKILL.md frontmatter.
const BUNDLED = {
  autoresearch: "Goal-directed research missions that interleave web research with data experimentation and end on a structured best-effort verdict",
  "deep-interview": "Socratic deep interview with mathematical ambiguity gating before explicit execution approval",
  ralplan: "Consensus planning entrypoint that auto-gates vague ultragoal requests before execution",
  ultragoal: "Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.",
} as const;

function settings(agentDir: string): Readonly<Record<string, unknown>> {
  try {
    const config: unknown = Bun.YAML.parse(readFileSync(join(agentDir, "config.yml"), "utf8"));
    return typeof config === "object" && config !== null && !Array.isArray(config) ? Object.fromEntries(Object.entries(config)) : {};
  } catch { return {}; /* missing or invalid YAML uses gjc's defaults */ }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function customCommandFiles(root: string, origin: "user" | "project"): SlashCommand[] {
  const commands: SlashCommand[] = [];
  const ancestors = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md")) {
            const name = relative(root, path).slice(0, -3).split(sep).join(":");
            commands.push({ name, description: description(readFileSync(path, "utf8")), source: origin, id: realpathSync(path) });
          }
        } catch { continue; }
      }
    } finally { ancestors.delete(canonical); }
  };
  visit(root);
  return commands;
}

export const source: AgentCommandSource = {
  builtins: ACTIVE_BUILTINS,
  descriptions: ACTIVE_DESCRIPTIONS,
  forms: ACTIVE_FORMS,
  terminalBound: TERMINAL_BOUND,
  pin: "0.18.12",
  discover({ home, cwd, env }) {
    const environ = environRecord(env);
    const expand = (path: string): string => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
    const agentDir = expand(environ.GJC_CODING_AGENT_DIR || environ.PI_CODING_AGENT_DIR || join(home, ".gjc", "agent"));
    const configDir = environ.GJC_CONFIG_DIR || environ.PI_CONFIG_DIR || ".gjc";
    const config = settings(agentDir);
    const ancestors = cwd ? ancestorsToRepoRoot(cwd, home) : [];
    const projectRootConfig = cwd ? settings(join(cwd, ".gjc")) : {};
    const projectConfig = record(projectRootConfig.skills);
    const requestedProfile = environ.GJC_PROFILE || environ.PI_PROFILE ||
      (typeof config.profile === "string" ? config.profile : "");
    const profile = requestedProfile !== "default" &&
      /^[a-z0-9][a-z0-9._-]{0,63}$/.test(requestedProfile) &&
      requestedProfile !== "." && requestedProfile !== ".." ? requestedProfile : "";
    const profileAgentDir = profile ? join(agentDir, "profiles", profile, "agent") : agentDir;
    const activeConfig = profile ? { ...config, ...settings(profileAgentDir) } : config;
    const commands = new Map<string, SlashCommand>();
    const addCommands = (root: string, origin: "user" | "project"): void => {
      for (const command of customCommandFiles(root, origin)) {
        if (!commands.has(command.name)) commands.set(command.name, command);
      }
    };
    if (cwd) addCommands(join(cwd, ".gjc", "commands"), "project");
    addCommands(join(profileAgentDir, "commands"), "user");
    const skills = new Map<string, SlashCommand>(Object.entries(BUNDLED).map(([name, description]) => [
      name, { name: `skill:${name}`, description, source: "skill", origin: "bundled", id: `skill:${name}` },
    ]));
    const settingsSkills = { ...record(config.skills), ...record(activeConfig.skills) };
    const enabled = settingsSkills.enabled !== false && projectConfig.enabled !== false;
    const ignored = [...strings(settingsSkills.ignoredSkills), ...strings(projectConfig.ignoredSkills)]
      .map((pattern) => new Bun.Glob(pattern));
    const includedValues = [...strings(settingsSkills.includeSkills), ...strings(projectConfig.includeSkills)];
    const included = includedValues.map((pattern) => new Bun.Glob(pattern));
    const disabledExtensions = [...strings(activeConfig.disabledExtensions), ...strings(projectRootConfig.disabledExtensions)];
    const addConfiguredSkills = (root: string, origin: "user" | "project"): void => {
      for (const skill of walkSkills(root, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true })) {
        const name = skill.name;
        if (!name || ignored.some((glob) => glob.match(name)) ||
          (included.length > 0 && !included.some((glob) => glob.match(name))) ||
          disabledExtensions.includes(`skill:${name}`) || disabledExtensions.includes(name)) continue;
        if (!skills.has(name)) skills.set(name, {
          name: `skill:${name}`, description: skill.description, source: "skill", origin, id: skill.id,
        });
      }
    };
    if (enabled && projectConfig.trustProjectSkills !== false && projectConfig.enablePiProject !== false &&
      settingsSkills.trustProjectSkills !== false && settingsSkills.enablePiProject !== false) {
      for (const ancestor of ancestors) addConfiguredSkills(join(ancestor, ".gjc", "skills"), "project");
    }
    const trustUserSkills = settingsSkills.trustUserSkills !== false && settingsSkills.enablePiUser !== false;
    if (enabled && trustUserSkills) {
      for (const root of [
        join(profileAgentDir, "skills"),
        join(home, configDir, "skills"),
        join(home, ".gjc", "skills"),
      ]) addConfiguredSkills(root, "user");
      if (Array.isArray(settingsSkills.customDirectories)) {
        for (const directory of settingsSkills.customDirectories) {
          if (typeof directory !== "string") continue;
          const expanded = expand(directory);
          addConfiguredSkills(isAbsolute(expanded) ? expanded : join(cwd ?? home, expanded), "user");
        }
      }
    }
    return [...commands.values(), ...skills.values()];
  },
};
