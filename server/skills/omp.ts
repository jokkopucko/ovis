import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandContext, AgentCommandSource } from "./index.ts";
import { SkillIgnore } from "../skill-ignore.ts";
import { description, environRecord, plainObject, readFrontmatter, readSkillText, walkSkills } from "./walk.ts";

/**
 * Builtins follow omp's own registry, can1357/oh-my-pi 53a0377db6845e0dae606146130766ec92d407fd
 * (18.12.3) packages/coding-agent/src/slash-commands/builtin-{modes,collaboration,session,lifecycle,
 * marketplace,skills,control}.ts, assembled in builtin-registry.ts. Skills follow
 * extensibility/skills.ts (same-name skills with different content are `<namespace>/<name>`) and
 * capability/index.ts (`disabledProviders`, `enabledProviders`); discovery/{claude,codex,...}.ts.
 * No Python `$` menu. Invocation-only extension/plugin roots cannot be recovered from file settings.
 */
const BUILTINS = [
  "settings", "model", "effort", "agents", "tree", "mcp", "resume", "plugins", "skills", "skillful",
  "ratchet", "modelpreset", "forget-approvals", "seance",
  "login", "logout", "goal", "session", "usage", "security", "setup", "plan",
  "plan-review", "vibe", "guided-goal", "loop", "queue", "switch", "fast", "slow", "extended-context", "computer", "prewalk",
  "advisor", "export", "trace", "dump", "share", "collab", "join", "leave", "browser",
  "copy", "open", "todo", "jobs", "stats", "changelog", "hotkeys", "tools", "context",
  "extensions", "git", "hub", "branch", "fork", "ssh", "new", "fresh", "clear",
  "delete", "compact", "shake", "handoff", "pin", "btw", "tan", "omfg", "cleanse",
  "retry", "debug", "memory", "rename", "move", "wt", "add-dir", "remove-dir", "dirs",
  "exit", "restart", "marketplace", "reload-plugins", "force", "live", "record",
  "pause", "quit", "init",
] as const;
// review, autoresearch and green are bundled extensions in omp, not registry builtins: they are
// listed only when an installed extension provides them. `skill:` is a group, not a command.

// Registry aliases reserve their names as well: a file command named like one never runs.
const ALIASES = ["providers", "models", "status", "rewind", "worktree", "plugin", "force:", "q"] as const;

// Terminal-only: no `handle` in the registry (handleTui only), except btw whose answer omp stores
// in its side store (#1380); the 18.5+ informational reports omp never writes to the transcript
// (CHANGELOG 18.5.0); and the screens this list used to exclude by name.
const TERMINAL_BOUND = [
  "settings", "setup", "plan", "plan-review", "vibe", "goal", "guided-goal", "loop", "queue", "collab", "join",
  "leave", "copy", "open", "hotkeys", "extensions", "agents", "git", "hub", "branch", "fork", "tree", "login",
  "logout", "new", "clear", "delete", "resume", "tan", "omfg", "cleanse", "debug", "exit", "restart", "skills",
  "live", "record", "pause", "quit", "seance",
  "changelog", "context", "tools", "usage", "stats", "session", "dirs",
  "mcp", "plugins", "effort",
  // the MoveOverlay path picker, and a "Create directory?" confirmation for a path that does not exist
  // (modes/controllers/command-controller.ts:1633-1675)
  "move",
] as const;
const TERMINAL_FORMS: CommandForm[] = [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }];
const FORMS: Record<string, CommandForm[]> = {
  ...Object.fromEntries(TERMINAL_BOUND.map((name) => [name, TERMINAL_FORMS])),
  // The chat sends a bare /model as /switch (server/core/composer.ts): omp's own /model opens its
  // Models hub, which saves the default role for later sessions, and /switch its session-only
  // picker, which the omp-model card answers. /model <args> sets the model and is stored as a model change.
  model: [{ match: "bare", interaction: "dialog", dialog: "omp-model" }, { match: "other", interaction: "none" }],
  // /switch typed by hand opens that same session-only picker (slash-commands/builtin-modes.ts:534-548)
  switch: [{ match: "bare", interaction: "dialog", dialog: "omp-model" }, { match: "other", interaction: "none" }],
  // omp compacts in place since 17.4.0, and with or without focus instructions shows only the
  // "Generating handoff" status, cancelled with Esc (recorded on 18.8.7): no $EDITOR step.
  handoff: [{ match: "bare", interaction: "dialog", dialog: "omp-handoff" }, { match: "other", interaction: "dialog", dialog: "omp-handoff" }],
  // bare opens the BTW history overlay, which keeps focus until Esc (modes/controllers/btw-controller.ts:394-401);
  // a question is answered in a panel while the editor keeps focus
  btw: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  // bare opens a selector (builtin-modes.ts:857-880, slash-commands/builtin-marketplace.ts:246); the subcommands report a status
  modelpreset: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  marketplace: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  // `/advisor configure` and `/todo edit` open the PC's editor (slash-commands/builtin-collaboration.ts:171,
  // modes/controllers/todo-command-controller.ts:166)
  advisor: [{ match: "bare", interaction: "unknown" }, { match: { sub: "configure" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  todo: [{ match: "bare", interaction: "unknown" }, { match: { sub: "edit" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
};

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
function config(path: string): Record<string, unknown> {
  try { return plainObject(path.endsWith(".json") ? JSON.parse(readFileSync(path, "utf8")) : Bun.YAML.parse(readFileSync(path, "utf8"))); }
  catch { return {}; }
}
function files(directory: string, recursive = false): string[] {
  const ignore = new SkillIgnore();
  const ancestors: string[] = [];
  for (let dir = directory; ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  for (const dir of ancestors) {
    try { ignore.add(readFileSync(join(dir, ".gitignore"), "utf8"), relative(ancestors[0] ?? directory, dir).split(sep).filter(Boolean).join("/") + (dir === ancestors[0] ? "" : "/")); }
    catch {}
  }
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith(".")) return [];
      const path = join(directory, entry.name);
      if (ignore.ignores(relative(ancestors[0] ?? directory, path).split(sep).join("/") + (entry.isDirectory() ? "/" : ""))) return [];
      if (recursive && entry.isDirectory()) return files(path, true);
      if (!entry.name.endsWith(".md")) return [];
      if (entry.isFile()) return [path];
      try { return entry.isSymbolicLink() && statSync(path).isFile() ? [path] : []; }
      catch { return []; }
    });
  } catch { return []; }
}
// Foreign tools whose ~/ config omp treats as opt-in (capability/index.ts FOREIGN_USER_PROVIDERS).
const FOREIGN_USER_PROVIDERS: ReadonlySet<string> = new Set(["cursor", "codex", "claude", "claude-plugins", "gemini", "opencode", "windsurf", "github"]);
// only blanks after the opening `---`: `\s*` there made an unclosed header quadratic (walk.ts)
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/;

/** extensibility/skills.ts skillNamespace: the plugin, else the directory owning `skills/`, else the provider. */
function skillNamespace(path: string, plugin: string | undefined, provider: string): string {
  let root = plugin;
  if (root === undefined) {
    const segments = path.split(/[\\/]/);
    const skills = segments.lastIndexOf("skills");
    const owner = skills > 0 ? segments[skills - 1] : segments[segments.length - 3];
    const cached = owner?.split("___");
    root = cached?.length === 3 ? cached[1] : owner;
  }
  if (!root || root.startsWith(".")) return provider;
  return root.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || provider;
}

interface Admitted { readonly raw: string; readonly path: string; readonly fields: Readonly<Record<string, unknown>> }
/** Same content: identical body and frontmatter, as extensibility/skills.ts compares them. */
function identical(left: Admitted, right: Admitted): boolean {
  try {
    return Bun.deepEquals(left.fields, right.fields) && readSkillText(left.path).replace(FRONTMATTER, "") === readSkillText(right.path).replace(FRONTMATTER, "");
  } catch { return false; }
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

type Level = "user" | "project";
interface Root {
  readonly path: string;
  readonly level: Level;
  readonly provider: string;
  readonly origin?: "plugin";
  readonly plugin?: string;
}

function discover(ctx: AgentCommandContext): SlashCommand[] {
  const { home } = ctx;
  const cwd = ctx.cwd ?? home;
  const env = environRecord(ctx.env);
  const expand = (path: string): string => resolve(cwd, path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
  const configRoot = join(home, env.PI_CONFIG_DIR || ".omp");
  const baseConfig = config(join(configRoot, "agent", "config.yml"));
  const profile = env.OMP_PROFILE ?? env.PI_PROFILE ?? (typeof baseConfig.profile === "string" ? baseConfig.profile : "");
  const named = profile && profile !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) && profile !== "." && profile !== "..";
  const agentDir = ctx.roots.agentDir || (named ? join(configRoot, "profiles", profile, "agent") : env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR) : join(configRoot, "agent"));
  // Settings belong to the active profile; cwd config overrides user config.
  const settings = config(join(agentDir, "config.yml"));
  const projectSettings = config(join(cwd, ".omp", "config.yml"));
  const skillsSettings = { ...plainObject(settings.skills), ...plainObject(projectSettings.skills) };
  const commandSettings = { ...plainObject(settings.commands), ...plainObject(projectSettings.commands) };
  const ancestors: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    ancestors.push(dir);
    if (existsSync(join(dir, ".git")) || dir === home || dirname(dir) === dir) break;
  }
  const root = (path: string, level: Level, provider: string): Root => ({ path, level, provider });
  const project = (dir: string, provider: string): Root[] =>
    ancestors.filter((path) => path !== home).map((path) => root(join(path, dir), "project", provider));
  const nativeUser = root(agentDir, "user", "native");
  const nativeProject = root(join(cwd, ".omp"), "project", "native");
  const native = [nativeProject, nativeUser];
  const nativeSkills = [...ancestors.map((dir) => root(join(dir, ".omp"), "project", "native")), nativeUser];
  const claudeDir = env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : join(home, ".claude");
  const claude = [root(claudeDir, "user", "claude"), ...project(".claude", "claude")];
  const agents = [...ancestors.filter((dir) => dir !== home).flatMap((dir) => [".agent", ".agents"].map((name) => root(join(dir, name), "project", "agents"))),
    ...[".agent", ".agents"].map((name) => root(join(home, name), "user", "agents"))];
  const codex = [root(join(home, ".codex"), "user", "codex"), root(join(cwd, ".codex"), "project", "codex")];
  const opencode = [root(join(home, ".config", "opencode"), "user", "opencode"), root(join(cwd, ".opencode"), "project", "opencode")];
  const github = root(join(cwd, ".github"), "project", "github");

  // omp reads `extensions` from its effective config.yml: the project's array replaces the user's.
  const extensions: Root[] = [];
  const projectExtensions = Array.isArray(projectSettings.extensions);
  for (const path of strings(projectExtensions ? projectSettings.extensions : settings.extensions)) {
    extensions.push({ path: expand(path), level: projectExtensions ? "project" : "user", provider: "omp-plugins", origin: "plugin" });
  }
  const pluginRoot = join(configRoot, "plugins");
  const pluginScopes = [root(pluginRoot, "user", "omp-plugins"),
    root(join(ancestors.find((dir) => existsSync(join(dir, ".omp")) || existsSync(join(dir, ".git"))) ?? cwd, ".omp", "plugins"), "project", "omp-plugins")];
  const overrides = config(join(cwd, ".omp", "plugin-overrides.json"));
  const installed = new Map<string, Root>();
  for (const scope of pluginScopes) {
    const runtime = plainObject(config(join(scope.path, "omp-plugins.lock.json")).plugins);
    const dependencies = plainObject(config(join(scope.path, "package.json")).dependencies);
    for (const name of new Set([...Object.keys(dependencies), ...Object.keys(runtime)])) {
      const path = join(scope.path, "node_modules", name);
      const pkg = config(join(path, "package.json"));
      if ((!pkg.omp && !pkg.pi) || plainObject(runtime[name]).enabled === false || strings(overrides.disabled).includes(name)) continue;
      installed.set(name, { ...scope, path, origin: "plugin" });
    }
  }
  extensions.push(...installed.values());
  // Installed registries, not arbitrary cache versions, determine active marketplace plugins.
  const marketplaces = new Map<string, Root[]>();
  const enabledPlugins = Object.assign({}, plainObject(config(join(claudeDir, "settings.json")).enabledPlugins),
    ...[...ancestors].reverse().flatMap((dir) => ["settings.json", "settings.local.json"].map((name) => plainObject(config(join(dir, ".claude", name)).enabledPlugins))));
  for (const scope of [root(join(claudeDir, "plugins"), "user", "claude-plugins"), ...pluginScopes]) {
    for (const [id, entries] of Object.entries(plainObject(config(join(scope.path, "installed_plugins.json")).plugins))) {
      const roots: Root[] = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const record = plainObject(entry);
        if (record.enabled === false || typeof record.installPath !== "string") continue;
        const level = record.scope === "project" || record.scope === "local" || scope.level === "project" ? "project" : "user";
        if (scope.provider === "claude-plugins" && (enabledPlugins[id] === false || (level === "project" && enabledPlugins[id] !== true && record.projectPath !== (ancestors.find((dir) => existsSync(join(dir, ".git"))) ?? cwd)))) continue;
        roots.push({ path: record.installPath, level, provider: "claude-plugins", origin: "plugin", plugin: id.split("@")[0] });
      }
      marketplaces.set(id, roots);
    }
  }
  const marketplaceRoots = [...marketplaces.values()].flat();
  const pluginDirectories = (scope: Root, kind: "skills" | "commands"): string[] => {
    const manifest = config(join(scope.path, ".claude-plugin", "plugin.json"));
    const declared = manifest[kind] ?? (kind === "commands" ? manifest["slash-commands"] : undefined);
    const configured = typeof declared === "string" ? [declared] : strings(declared);
    const dirs = (kind === "skills" || configured.length === 0 ? [join(scope.path, kind)] : []).concat(configured.map((path) => resolve(scope.path, path)));
    return [...new Set(dirs)].filter((path) => !relative(scope.path, path).startsWith(".."));
  };
  const targetsPortable = (scope: Root): boolean => {
    const schema = config(join(scope.path, "plugin.json")).$schema;
    return typeof schema === "string" && schema.startsWith("https://agent-plugins.org/schemas/");
  };
  const portable = [...marketplaceRoots, ...extensions].filter((scope) => {
    const manifest = config(join(scope.path, "plugin.json"));
    if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
        typeof manifest.name !== "string" || manifest.name.length > 64 ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name) || /--|\.\./.test(manifest.name)) return false;
    if (["version", "description", "homepage", "repository", "license"].some((key) => manifest[key] !== undefined && typeof manifest[key] !== "string")) return false;
    if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some((item) => typeof item !== "string"))) return false;
    if (manifest.author !== undefined && (typeof manifest.author !== "object" || manifest.author === null || Array.isArray(manifest.author) ||
        Object.entries(plainObject(manifest.author)).some(([key, value]) => !["name", "email", "url"].includes(key) || typeof value !== "string"))) return false;
    return true;
  });
  const legacyExtensions = extensions.filter((scope) => !targetsPortable(scope));
  const legacyMarketplaces = marketplaceRoots.filter((scope) => !targetsPortable(scope));
  const skillRoots = [...nativeSkills, ...legacyExtensions, ...claude, ...portable,
    ...legacyMarketplaces, ...agents, ...codex, ...opencode, github];
  // capability/index.ts: `disabledProviders` switches a whole provider off; `enabledProviders` opts a foreign
  // user source in. The project's array replaces the user's, as for every omp setting.
  const providerSet = (key: string): Set<string> => new Set(strings(Array.isArray(projectSettings[key]) ? projectSettings[key] : settings[key]));
  const disabledProviders = providerSet("disabledProviders");
  const enabledProviders = providerSet("enabledProviders");
  const providerOn = (scope: Root): boolean => !disabledProviders.has(scope.provider);
  const optedIn = (scope: Root): boolean => scope.level === "user" && FOREIGN_USER_PROVIDERS.has(scope.provider) &&
    [scope.provider, "*", "all", ...(scope.provider === "claude-plugins" ? ["claude"] : [])].some((id) => enabledProviders.has(id));
  const thirdParty = ["enableCodexUser", "enableClaudeUser", "enableClaudeProject", "enablePiUser", "enablePiProject"].some((key) => skillsSettings[key] !== false);
  const enabled = (scope: Root): boolean => {
    const toggle = scope.provider === "native" ? `enablePi${scope.level === "user" ? "User" : "Project"}`
      : scope.provider === "agents" ? `enableAgents${scope.level === "user" ? "User" : "Project"}`
      : scope.provider === "claude" ? `enableClaude${scope.level === "user" ? "User" : "Project"}`
      : scope.provider === "codex" && scope.level === "user" ? "enableCodexUser" : null;
    return providerOn(scope) && ((toggle ? skillsSettings[toggle] !== false : thirdParty) || optedIn(scope));
  };
  const commands: SlashCommand[] = [];
  const names = new Set<string>(BUILTINS);
  const seenPaths = new Set<string>();
  const admitted = new Map<string, Admitted>();
  const ignored = strings(skillsSettings.ignoredSkills).map((pattern) => new Bun.Glob(pattern));
  const included = strings(skillsSettings.includeSkills).map((pattern) => new Bun.Glob(pattern));
  const disabled = strings(settings.disabledExtensions).concat(strings(projectSettings.disabledExtensions));
  const addSkills = (scope: Root, directories = [join(scope.path, "skills")]): void => {
    for (const directory of directories) for (const skill of walkSkills(directory, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true })) {
      const name = skill.name.trim();
      if (!name || name.startsWith(".") || /[\\/]/.test(name) || skill.fields.enabled === false || disabled.includes(`skill:${name}`) ||
          ignored.some((glob) => glob.match(name))) continue;
      const canonical = skill.id ?? canonicalPath(skill.path);
      if (portable.some((item) => item.path === scope.path)) {
        // Portable packages require spec names and contained skills, unlike legacy providers.
        const declared = skill.fields.name;
        const allowed = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"];
        if (typeof declared !== "string" || declared !== basename(dirname(skill.path)) ||
            declared.length > 64 || declared !== declared.toLowerCase() || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(declared) ||
            skill.description.length > 1024 || Object.keys(skill.fields).some((key) => !allowed.includes(key)) ||
            ["license", "allowed-tools", "compatibility"].some((key) => skill.fields[key] !== undefined && typeof skill.fields[key] !== "string") ||
            (typeof skill.fields.compatibility === "string" && skill.fields.compatibility.length > 500) ||
            (skill.fields.metadata !== undefined && (typeof skill.fields.metadata !== "object" || skill.fields.metadata === null || Array.isArray(skill.fields.metadata) || Object.values(plainObject(skill.fields.metadata)).some((value) => typeof value !== "string"))) ||
            relative(realpathSync(scope.path), canonical).startsWith("..")) continue;
      }
      if (seenPaths.has(canonical)) continue;
      // A same-name skill with identical content collapses into the first; a different one is `<namespace>/<name>`.
      const candidate: Admitted = { raw: name, path: skill.path, fields: skill.fields };
      const same = [...admitted.entries()].filter(([, entry]) => entry.raw === name);
      let final = name;
      // extensibility/skills.ts: managed skills resolve last and defer to any authored skill of the same name.
      if (scope.provider === "managed" && same.length > 0) continue;
      if (same.length > 0) {
        if (same.some(([, entry]) => identical(entry, candidate))) continue;
        const namespace = skillNamespace(skill.path, scope.plugin, scope.provider);
        final = `${namespace}/${name}`;
        for (let count = 2; admitted.has(final); count += 1) final = `${namespace}/${name}~${count}`;
      }
      if (disabled.includes(`skill:${final}`) || ignored.some((glob) => glob.match(final))) continue;
      admitted.set(final, candidate); seenPaths.add(canonical);
      commands.push({ name: `skill:${final}`, description: skill.description, source: "skill", origin: scope.origin ?? scope.level, id: canonical });
    }
  };
  if (skillsSettings.enabled !== false && skillsSettings.enableSkillCommands !== false) {
    // Explicit custom roots override defaults; same-source custom duplicates keep first wins.
    for (const directory of strings(skillsSettings.customDirectories)) addSkills(root(expand(directory), "user", "custom"), [expand(directory)]);
    for (const scope of skillRoots.filter(enabled)) addSkills(scope, scope.plugin && !portable.includes(scope) ? pluginDirectories(scope, "skills") : undefined);
    addSkills(root(agentDir, "user", "managed"), [join(agentDir, "managed-skills")]);
    // Include patterns match the final name once every name is settled, so a namespaced copy cannot bypass them.
    if (included.length > 0) commands.splice(0, commands.length, ...commands.filter((command) => included.some((glob) => glob.match(command.name.slice("skill:".length)))));
  }
  const allBuiltinNames = new Set<string>([...names, ...ALIASES]);
  const addCommand = (command: SlashCommand): void => {
    if (allBuiltinNames.has(command.name)) return;
    allBuiltinNames.add(command.name); commands.push(command);
  };
  const claudeCommands = [root(claudeDir, "user", "claude"), root(join(cwd, ".claude"), "project", "claude")];
  for (const scope of [...native, ...legacyExtensions, ...claudeCommands, ...legacyMarketplaces, ...agents, ...codex, ...opencode]) {
    if (!providerOn(scope)) continue;
    if (["claude", "opencode"].includes(scope.provider) && commandSettings[`enable${scope.provider === "claude" ? "Claude" : "Opencode"}${scope.level === "user" ? "User" : "Project"}`] === false && !optedIn(scope)) continue;
    const directories = scope.plugin ? pluginDirectories(scope, "commands") : [join(scope.path, "commands")];
    for (const directory of directories) for (const path of files(directory, scope.provider === "claude")) {
      const fields = readFrontmatter(path);
      const name = (scope.provider === "codex" || scope.provider === "opencode") && typeof fields?.name === "string" ? fields.name : basename(path, ".md");
      let text: string;
      try { text = readSkillText(path); } catch { continue; }
      const fallback = description(text);
      const desc = typeof fields?.description === "string" ? fields.description.trim() : fallback.length > 60 ? `${fallback.slice(0, 60)}...` : fallback;
      const command = { name: scope.plugin ? `${scope.plugin}:${name}` : name, description: desc, source: scope.level, id: canonicalPath(path) };
      addCommand(command);
      if (scope.provider === "claude" && relative(directory, path).includes(sep)) addCommand({ ...command, name: relative(directory, path).slice(0, -3).split(sep).join(":") });
    }
  }
  // Native templates are recursive and user-first, with the runtime's source suffix.
  for (const scope of [nativeUser, nativeProject, ...legacyExtensions, ...agents, ...codex, github]) {
    if (!providerOn(scope)) continue;
    const directory = join(scope.path, "prompts");
    for (const path of files(directory, scope.provider === "native")) {
      if (scope.provider === "github" && !path.endsWith(".prompt.md")) continue;
      const subdir = dirname(relative(directory, path)).split(sep).join(":");
      const suffix = `(${scope.level}${subdir === "." ? "" : `:${subdir}`})`;
      const fields = readFrontmatter(path);
      let markdown: string;
      try { markdown = readSkillText(path); } catch { continue; }
      const fallback = description(markdown);
      const desc = typeof fields?.description === "string" ? fields.description : fallback.length > 60 ? `${fallback.slice(0, 60)}...` : fallback;
      const name = (scope.provider === "github" || scope.provider === "codex") && typeof fields?.name === "string" ? fields.name : basename(path, scope.provider === "github" ? ".prompt.md" : ".md");
      addCommand({ name, description: desc ? `${desc} ${suffix}` : suffix, source: scope.level, id: canonicalPath(path) });
    }
  }
  return commands;
}

// What each command does, as the pinned registry's own definitions say it (slash-commands/builtin-*.ts and
// seance.ts `description`). Where upstream computes the text, the stable part is kept: loop and effort end in a
// key hint ("Esc suspends...", "shift+tab cycles levels") that follows the user's keybindings, and switch names
// its default key. A toggle's current state (the palette's "Context: 1% ...") is one session's state, not a
// description, so it is not copied. init is omp's embedded command, which the registry does not define.
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  "security": "Plan, run, inspect, import, and compare OMP-native security scans",
  "settings": "Open settings menu",
  "setup": "Open provider setup",
  "plan": "Toggle plan mode (agent plans before executing)",
  "plan-review": "Re-open the plan review for the latest plan (plan mode only)",
  "vibe": "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
  "goal": "Toggle goal mode (persistent autonomous objective for this session)",
  "guided-goal": "Have the agent interview you in chat, then set up goal mode",
  "loop": "Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Bound it with a count/duration, or gate it with `--until '<cmd>'` / `--while '<cmd>'` — the command's exit status decides whether the next iteration runs.",
  "queue": "Queue a message for after the agent yields",
  "model": "Switch model for this session",
  "switch": "Switch model for this session (same as alt+p); accepts fuzzy ids, provider/id, @role, :level",
  "fast": "Toggle fast service (OpenAI service_tier=priority or ultrafast, Anthropic speed=fast, Google priority)",
  "slow": "Toggle slow mode: flex tier on OpenAI/Google; on Anthropic, continue at low priority after the Claude session limit",
  "skillful": "Toggle listing available skills in the system prompt (session only)",
  "extended-context": "Toggle extended context windows",
  "computer": "Toggle the native computer-use eval prelude for this session",
  "ratchet": "Build (or reuse) an eval for an LLM flow, then hillclimb it unattended",
  "prewalk": "Arm, restart, or cancel a one-shot model handoff",
  "modelpreset": "Save and switch model presets (role models + thinking level)",
  "effort": "Set reasoning effort (thinking level, intelligence) for this session",
  "advisor": "Toggle the advisor (a second model that reviews each turn and injects notes)",
  "export": "Export session to HTML file",
  "trace": "Open this session's trace in the stats dashboard",
  "dump": "Copy session transcript to clipboard (and write LLM request JSON to tmp)",
  "share": "Share session via an encrypted link (share server or secret gist)",
  "collab": "Share this session live via a relay",
  "join": "Join a shared collab session",
  "leave": "Leave the collab session",
  "browser": "Toggle browser eval-prelude headless vs visible mode",
  "copy": "Pick text or code from the conversation to copy",
  "open": "Open the last link from the conversation in your browser (or pick one with /copy)",
  "todo": "View or modify the agent's todo list",
  "session": "Session management commands",
  "jobs": "Show async background jobs status",
  "usage": "Show provider usage and limits",
  "stats": "Launch the local stats dashboard",
  "changelog": "Show changelog entries",
  "hotkeys": "Show all keyboard shortcuts",
  "tools": "Show tools currently visible to the agent",
  "context": "Show estimated context usage breakdown",
  "extensions": "Open Extension Control Center dashboard",
  "agents": "Open the agents hub (per-agent model, prewalk, and advisor)",
  "git": "Open the git UI (split diff viewer, staging, commit composer)",
  "hub": "Open the live Agent Hub",
  "branch": "Rewind to a previous message, keeping the old path as a branch",
  "fork": "Fork this session, or open it in a multiplexer pane or window",
  "tree": "Navigate session tree (switch branches)",
  "login": "Login with OAuth provider",
  "logout": "Logout from OAuth provider",
  "mcp": "Manage MCP servers (add, list, remove, test)",
  "ssh": "Manage SSH hosts (add, list, remove)",
  "new": "Start a new session",
  "fresh": "Reset provider stream state without changing the local transcript",
  "clear": "Clear the conversation context in place, keeping the session",
  "delete": "Delete the current session and start a new one",
  "compact": "Manually compact the session context",
  "shake": "Drop heavy content from context (tool results, large blocks)",
  "handoff": "Summarize the session into a handoff document and compact in place",
  "resume": "Resume a different session",
  "pin": "Pin or unpin a session at the top of the resume list",
  "btw": "Ask a side question, or browse this session's BTW history",
  "tan": "Run a full background agent on tangential work",
  "omfg": "Forge a TTSR rule from a complaint to stop a recurring behavior",
  "cleanse": "Detect and fix project diagnostics with weighted parallel subagents",
  "retry": "Retry the last failed agent turn",
  "debug": "Open debug tools selector",
  "memory": "Inspect and operate memory maintenance",
  "rename": "Rename the current session (omit title to generate)",
  "move": "Move the current session to a different directory",
  "wt": "Move this session into a new worktree, changes included",
  "add-dir": "Add a workspace directory to this session (multi-root)",
  "remove-dir": "Remove a workspace directory from this session",
  "dirs": "List this session's workspace directories",
  "exit": "Exit the application",
  "restart": "Restart omp with the same launch flags, resuming this session",
  "marketplace": "Manage marketplace plugin sources and installed plugins",
  "plugins": "View and manage installed plugins",
  "reload-plugins": "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
  "skills": "Search, install, and update skills from the skills.omp.sh registry",
  "force": "Force next turn to use a specific tool",
  "live": "Start Codex-backed realtime voice mode",
  "record": "Start or stop recording this screen to a replayable file (omp play)",
  "pause": "Freeze all agents (main, subagents, advisor) until resumed",
  "forget-approvals": "Forget every file and folder approval Ask and remember has recorded",
  "quit": "Quit the application",
  "seance": "Consult a saved session without resuming it",
  "init": "Generate AGENTS.md for current codebase",
};

export const source: AgentCommandSource = {
  builtins: BUILTINS, descriptions: DESCRIPTIONS, discover, forms: FORMS, terminalBound: TERMINAL_BOUND, pin: "18.12.3",
};
