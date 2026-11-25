import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { createWalkBudget, customCommands, environValue, parseJsonc, plainObject, walkSkills } from "./walk.ts";

/**
 * Devin CLI 3000.11.92, cross-checked against https://cli.devin.ai/docs/changelog: imported
 * skill roots default on and read_config_from only disables providers set to false. Native roots are
 * one level deep; imported Claude/Copilot skills recurse. Invocation names are directory names.
 * MCP configuration follows Devin's documented mcp_config.json/mcpServers layout; prompts are
 * exposed only when declared on disk, without connecting to a server.
 */
const descriptions = {
  usage: "Show session usage of credits / ACUs", context: "Show context window usage",
  mode: "Show or switch mode", bug: "Report a bug to the Devin CLI developers",
  handoff: "Hand off between local and Devin cloud", "accept-edits": "Switch to accept edits mode",
  autonomous: "Switch to autonomous mode", billing: "Choose whether a provider plan pays for its models",
  btw: "Ask a quick side question without disrupting the conversation", bypass: "Switch to bypass mode",
  clear: "Clear conversation history", cloud: "Switch this session to run in Devin cloud",
  continue: "Resume the most recent session or a given session", copy: "Copy the last response to clipboard",
  dangerous: "Switch to bypass mode", exit: "Exit the application", feedback: "Rate the last response",
  fork: "Fork the current session", fusion: "Choose a Fusion model", help: "Show available commands",
  "list-sessions": "List recent sessions", login: "Re-authenticate with Devin in this session",
  "login-status": "Show login and authentication status", logout: "Clear stored credentials and exit",
  normal: "Switch to normal mode", org: "Select your Devin organization", quit: "Exit the application",
  "rename-session": "Rename the current session", revert: "Revert back to a previous step",
  "rm-session": "Delete a session", "session-stats": "Show session statistics",
  shortcuts: "Show keyboard shortcuts", smart: "Switch to smart mode", steps: "List conversation steps",
  title: "Rename the current session", update: "Check for and install updates",
  upgrade: "Upgrade your subscription plan", yolo: "Switch to bypass mode",
  status: "Check authentication status", workspace: "List workspace directories",
  "add-dir": "Add an additional workspace directory", "undo-add-dir": "Remove a workspace directory",
  "remove-dir": "Remove a workspace directory", ask: "Switch to Ask mode",
  plan: "Switch to Plan mode or plan with a prompt", code: "Switch to Code mode or run a prompt",
  compact: "Force conversation compaction", fast: "Switch to the fastest available model",
  loop: "Run a prompt then auto-review the diff in a loop",
  goal: "Set a goal the agent keeps working on until it is done", recap: "Recap the session",
  share: "Share this conversation with your team on Devin",
  pickup: "Pick up a Devin session", ssh: "Connect to a workspace over SSH",
  "bypass-permissions": "Switch to bypass permissions mode", models: "Choose a model",
  debug: "Show debugging information", workspaces: "List workspaces", rename: "Rename the session",
  mcp: "Manage Model Context Protocol servers", resume: "Resume a session",
  config: "Open configuration", hooks: "Manage hooks", theme: "Choose a theme",
  model: "Choose a model",
  "declarative-repo-setup": "Set up repository instructions for Devin",
  "upload-secrets": "Upload repository secrets to Devin",
} as const;

const terminalBound = [
  "status", "context", "session-stats", "help", "usage", "workspaces", "recap", "steps",
  "model", "models", "fusion", "org", "billing", "login", "login-status", "resume",
  "config", "hooks", "mcp", "theme",
  // checked on 3000.11.92 (2026-10-22): the shortcut picker, /btw's side chat with its own input, the handoff pickers,
  // and logout, which signs out and leaves
  "shortcuts", "btw", "handoff", "logout",
] as const;
const forms: Record<string, CommandForm[]> = {
  ...Object.fromEntries(terminalBound.map((name) => [
    name, [{ match: "bare" as const, interaction: "terminal" as const }],
  ])),
  // bare opens the "Select mode:" picker, the "Revert to step:" picker or the bug form; given a value they act
  mode: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  revert: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  bug: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  // bare lists the directories; a directory Devin has not trusted yet asks "Do you trust the authors…?"
  "add-dir": [{ match: "bare", interaction: "unknown" }, { match: "other", interaction: "terminal" }],
};

function importSettings(value: unknown): Map<string, boolean> {
  // Devin expects a structured object; arrays and other invalid values behave as no overrides.
  return new Map(Object.entries(plainObject(value)).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

function mcpPrompts(configs: readonly Record<string, unknown>[]): SlashCommand[] {
  const prompts = new Map<string, SlashCommand>();
  const servers = new Map<string, Record<string, unknown>>();
  for (const file of configs) {
    for (const [server, raw] of Object.entries(plainObject(file.mcpServers))) {
      servers.set(server, plainObject(raw));
    }
  }
  for (const [server, serverConfig] of servers) {
    if (serverConfig.disabled === true || !Array.isArray(serverConfig.prompts)) continue;
    for (const prompt of serverConfig.prompts) {
      if (typeof prompt !== "string" || !prompt) continue;
      const name = `mcp__${server}__${prompt}`;
      prompts.set(name, { name, description: `MCP prompt ${prompt} from ${server}`, source: "plugin", origin: "plugin", id: name });
    }
  }
  return [...prompts.values()];
}

function config(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return plainObject(parseJsonc(readFileSync(path, "utf8")));
  } catch { return {}; }
}

export const source: AgentCommandSource = {
  builtins: Object.keys(descriptions),
  chatPaletteHidden: ["accept-edits", "ask", "autonomous", "bypass", "bypass-permissions", "code", "dangerous", "fast", "normal", "plan", "smart", "yolo"],
  descriptions,
  pin: "3000.11.92",
  terminalBound,
  forms,
  discover({ home, cwd, repoRoot, env }) {
    const budget = createWalkBudget();
    const configHome = environValue(env, "XDG_CONFIG_HOME") ?? join(home, ".config");
    const dataHome = environValue(env, "XDG_DATA_HOME") ?? join(home, ".local", "share");
    const project = repoRoot ?? cwd;
    const userConfig = config(join(configHome, "devin", "config.json"));
    const projectConfig = config(project ? join(project, ".devin", "config.json") : "");
    const defaultImports = ["claude", "windsurf", "copilot", "cursor"].map((provider) => [provider, true] as const);
    const userImports = new Map<string, boolean>(defaultImports);
    for (const [name, enabled] of importSettings(userConfig.read_config_from)) userImports.set(name, enabled);
    const projectImports = new Map(userImports);
    for (const [name, enabled] of importSettings(projectConfig.read_config_from)) {
      if (!enabled) projectImports.set(name, false);
    }
    const found: { namespace: string; command: SlashCommand }[] = [];
    const add = (root: string, namespace: string, origin: SlashCommand["origin"], recursive = false, plugin = false): void => {
      for (const skill of walkSkills(root, { depth: recursive ? "recursive" : "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: false, budget })) {
        if (Array.isArray(skill.fields.triggers) && !skill.fields.triggers.includes("user")) continue;
        const name = basename(dirname(skill.path));
        found.push({ namespace, command: { name: plugin ? `${namespace}:${name}` : name, description: skill.description, source: "skill", origin, id: skill.id } });
      }
    };
    // Native source roots share a precedence tier: first directory wins within each scope.
    for (const [base, origin] of [[home, "user"], [project, "project"]] as const) {
      if (!base) continue;
      const imports = origin === "user" ? userImports : projectImports;
      const start = found.length;
      add(origin === "user" ? join(configHome, "devin", "skills") : join(base, ".devin", "skills"), "devin", origin);
      add(origin === "user" ? join(configHome, "cognition", "skills") : join(base, ".cognition", "skills"), "cognition", origin);
      add(join(base, ".agents", "skills"), "agents", origin);
      const seen = new Set<string>();
      for (let index = start; index < found.length;) {
        const item = found[index];
        if (!item) break;
        if (seen.has(item.command.name)) found.splice(index, 1);
        else { seen.add(item.command.name); index++; }
      }
      if (imports.get("windsurf")) add(origin === "user" ? join(home, ".codeium", "windsurf", "skills") : join(base, ".windsurf", "skills"), "windsurf", origin);
      if (imports.get("cursor")) add(origin === "user" ? join(home, ".cursor", "skills") : join(base, ".cursor", "skills"), "cursor", origin, true);
      if (imports.get("claude")) {
        add(join(base, ".claude", "skills"), "claude", origin, true);
        if (origin === "project") {
          const root = join(base, ".claude", "commands");
          for (const command of customCommands(root, "skill", budget,
            (fields) => !Array.isArray(fields.triggers) || fields.triggers.includes("user"))) {
            found.push({ namespace: "claude", command: { ...command, origin } });
          }
        }
      }
      if (imports.get("copilot")) add(origin === "user" ? join(environValue(env, "COPILOT_HOME") ?? join(home, ".copilot"), "skills") : join(base, ".github", "skills"), "copilot", origin, true);
    }
    const mcpConfigs = [
      userConfig,
      projectConfig,
      config(join(configHome, "devin", "mcp_config.json")),
      ...(project ? [
        config(join(project, ".devin", "mcp_config.json")),
        config(join(project, ".devin", "mcp_config.local.json")),
      ] : []),
    ];
    for (const command of mcpPrompts(mcpConfigs)) found.push({ namespace: "devin", command });
    const pluginRoot = join(dataHome, "devin", "cli", "plugins");
    const visited = new Set<string>();
    const plugins = (directory: string): void => {
      if (!existsSync(directory)) return;
      const canonical = realpathSync(directory);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      const manifestPath = [".devin-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"].map((path) => join(directory, path)).find(existsSync);
      if (manifestPath) {
        const manifest = config(manifestPath);
        if (typeof manifest.name !== "string") return;
        const roots = manifest.skills === undefined ? ["skills"] : typeof manifest.skills === "string" ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills : [];
        for (const root of roots) if (typeof root === "string") {
          const path = join(directory, root);
          if (!relative(directory, path).split(sep).includes("..")) add(path, manifest.name, "plugin", false, true);
        }
        return;
      }
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        try { if (statSync(path).isDirectory()) plugins(path); }
        catch { continue; }
      }
    };
    plugins(pluginRoot);
    // An imported skill that is the same file as a native one (~/.claude/skills linked to Devin's own
    // root) is that native skill: listed once under its native name, as Devin lists it.
    const native = new Set(["devin", "cognition", "agents"]);
    const nativeFiles = new Set(found.filter((item) => native.has(item.namespace)).map((item) => item.command.id));
    const listed = found.filter((item) => native.has(item.namespace) || item.command.id === undefined || !nativeFiles.has(item.command.id));
    const namespaces = new Map<string, Set<string>>();
    for (const { namespace, command } of listed) {
      const sources = namespaces.get(command.name) ?? new Set<string>();
      sources.add(namespace);
      namespaces.set(command.name, sources);
    }
    const result = new Map<string, SlashCommand>();
    for (const { namespace, command } of listed) {
      const name = (namespaces.get(command.name)?.size ?? 0) > 1 ? `${namespace}:${command.name}` : command.name;
      // Project overrides user only within the same source namespace.
      result.set(name, { ...command, name });
    }
    return [...result.values()];
  },
};
