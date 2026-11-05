import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentCommandContext, AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, environValue, piTemplates, plainObject, readFrontmatter, walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

// Docs-based, pi 0.87.1: upstream pi is not installed here, so what pi loads is built from its
// docs (skills.md, prompt-templates.md, settings.md, security.md), not read off a running pi.
// Skills are found recursively (a directory holding SKILL.md ends the descent; loose .md files
// count only directly in a root) and need a description. The agent directory and ~/.agents load
// always; the settings.json `skills` list adds paths; a project's .pi/skills, .agents/skills and
// .pi/prompts load only where project trust says so.

/** pi states what each command opens or does, in its own words, read off its palette. */
const PI_DESCRIPTIONS: Record<string, string> = {
  settings: "Open settings menu", model: "Select model (opens selector UI)", thinking: "Set thinking level",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", login: "Configure provider authentication",
  logout: "Remove provider authentication", new: "Start a new session",
  resume: "Resume a different session", name: "Set session display name", session: "Show session info and stats",
  fork: "Create a new fork from a previous user message",
  clone: "Duplicate the current session at the current position", compact: "Manually compact the session context",
  import: "Import and resume a session from a JSONL file", copy: "Copy last agent message to clipboard",
  export: "Export session (HTML default, or specify path: .html/.jsonl)", share: "Share session via a Radius artifact or a GitHub gist",
  bug: "Report a bug to the Pi developers", trust: "Save project trust decision for future sessions",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", hotkeys: "Show all keyboard shortcuts",
  changelog: "Show changelog entries", quit: "Quit pi", tree: "Navigate session tree (switch branches)",
  debug: "Write debug output to a log file", arminsayshi: "Armin says hi", dementedelves: "Show the Earendil announcement",
};

// Pi 1.4's submit handler runs these itself when typed exactly, though its menu does not list them.
const PI_AGENT_HIDDEN = ["debug", "arminsayshi", "dementedelves"];
// Canonical builtins and behavior from earendil-works/pi 5c1736f82d201d09664642ab0d88147da94b450e.
const PI_BUILTINS = [
  "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
  "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
  "compact", "resume", "reload", "quit", ...PI_AGENT_HIDDEN,
];
const PI_TERMINAL_BOUND = [
  "tree",
];
const PI_FORMS: NonNullable<AgentCommandSource["forms"]> = {
  model: [{ match: "bare", interaction: "dialog", dialog: "pi-model" }, { match: "other", interaction: "none" }],
  thinking: [{ match: "bare", interaction: "dialog", dialog: "pi-thinking" }, { match: "other", interaction: "none" }],
  tree: [{ match: "bare", interaction: "terminal" }],
  fork: [{ match: "bare", interaction: "terminal" }],
  resume: [{ match: "bare", interaction: "terminal" }],
  settings: [{ match: "bare", interaction: "terminal" }],
  "scoped-models": [{ match: "bare", interaction: "terminal" }],
  login: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  // `/compact <instructions>` focuses the summary
  compact: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }],
  session: [{ match: "bare", interaction: "terminal" }],
  hotkeys: [{ match: "bare", interaction: "terminal" }],
  changelog: [{ match: "bare", interaction: "terminal" }],
  logout: [{ match: "bare", interaction: "terminal" }],
  new: [{ match: "bare", interaction: "unknown" }],
  name: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
  clone: [{ match: "bare", interaction: "unknown" }],
  import: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  copy: [{ match: "bare", interaction: "terminal" }],
  export: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  share: [{ match: "bare", interaction: "terminal" }],
  bug: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  trust: [{ match: "bare", interaction: "terminal" }],
  reload: [{ match: "bare", interaction: "terminal" }],
  quit: [{ match: "bare", interaction: "terminal" }],
  debug: [{ match: "bare", interaction: "terminal" }],
  arminsayshi: [{ match: "bare", interaction: "terminal" }],
  dementedelves: [{ match: "bare", interaction: "terminal" }],
};


const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; /* absent or not JSON */ } };
const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

/** PI_CODING_AGENT_DIR from the pane's own environ first, then the server's, else ~/.pi/agent. */
function agentDirectory(home: string, env: readonly string[] | null, serverEnv: AgentCommandContext["serverEnv"]): string {
  const own = environValue(env, "PI_CODING_AGENT_DIR");
  const dir = own || (serverEnv ?? process.env)["PI_CODING_AGENT_DIR"];
  if (!dir) return join(home, ".pi", "agent");
  return dir === "~" || dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
}

/** Saved decisions in trust.json: an absolute path mapped to true/false, or a list of trusted paths. */
function savedDecisions(value: unknown, into = new Map<string, boolean>()): Map<string, boolean> {
  if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === "string" && isAbsolute(entry)) into.set(canonical(entry), true);
    return into;
  }
  for (const [key, entry] of Object.entries(plainObject(value))) {
    const fields = plainObject(entry);
    const verdict = typeof entry === "boolean" ? entry : typeof fields["trusted"] === "boolean" ? fields["trusted"] : typeof fields["trust"] === "boolean" ? fields["trust"] : null;
    if (isAbsolute(key) && verdict !== null) into.set(canonical(key), verdict);
    else if (!isAbsolute(key) && typeof entry === "object" && entry !== null) savedDecisions(entry, into);
  }
  return into;
}

/** pi's order without an interactive prompt: the closest saved decision, else defaultProjectTrust. */
function projectTrusted(agentDir: string, settings: Record<string, unknown>, cwd: string): boolean {
  const decisions = savedDecisions(readJson(join(agentDir, "trust.json")));
  for (let directory = canonical(cwd); ; directory = dirname(directory)) {
    const decision = decisions.get(directory);
    if (decision !== undefined) return decision;
    if (directory === dirname(directory)) break;
  }
  return settings["defaultProjectTrust"] === "always";
}

const asCommands = (found: ReturnType<typeof walkSkills>, origin: NonNullable<SlashCommand["origin"]>): SlashCommand[] =>
  found.map(({ name, description, path, id }) => ({ name: `skill:${name}`, description, source: "skill", origin, id: id ?? canonical(path) }));
const recursive = (root: string): ReturnType<typeof walkSkills> => walkSkills(root, { depth: "recursive", looseMarkdown: "root", ignoreFiles: false, requireDescription: true });

/** One settings entry's skills: a directory is walked, a .md file is one skill. */
function entrySkills(path: string): ReturnType<typeof walkSkills> {
  let target;
  try { target = statSync(path); } catch { return []; }
  if (target.isDirectory()) return recursive(path);
  if (!target.isFile() || !path.endsWith(".md")) return [];
  const fields = readFrontmatter(path);
  if (typeof fields?.["description"] !== "string" || !fields["description"].trim()) return [];
  const name = typeof fields["name"] === "string" && fields["name"] ? fields["name"] : basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md");
  return [{ name, description: fields["description"], path, fields, id: canonical(path) }];
}

/** The settings `skills` array: plain paths add, `+path` forces in, `-path` and `!glob` exclude. */
function settingsSkills(home: string, agentDir: string, settings: Record<string, unknown>): { added: ReturnType<typeof walkSkills>; forced: ReturnType<typeof walkSkills>; excluded: (path: string) => boolean } {
  const entries = Array.isArray(settings["skills"]) ? settings["skills"].filter((entry): entry is string => typeof entry === "string") : [];
  const location = (entry: string): string => resolve(agentDir, entry === "~" || entry.startsWith("~/") ? join(home, entry.slice(2)) : entry);
  const expand = (entry: string): string[] => {
    if (!/[*?[{]/.test(entry)) return [location(entry)];
    try { return [...new Bun.Glob(entry).scanSync({ cwd: agentDir, absolute: true, onlyFiles: false })]; } catch { return []; }
  };
  const added: ReturnType<typeof walkSkills> = [];
  const forced: ReturnType<typeof walkSkills> = [];
  const globs: Bun.Glob[] = [];
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("!")) globs.push(new Bun.Glob(entry.slice(1)));
    else if (entry.startsWith("-")) paths.push(location(entry.slice(1)));
    else if (entry.startsWith("+")) for (const path of expand(entry.slice(1))) forced.push(...entrySkills(path));
    else for (const path of expand(entry)) added.push(...entrySkills(path));
  }
  const excluded = (path: string): boolean => {
    const directory = dirname(path);
    return paths.some((entry) => path === entry || directory === entry || path.startsWith(entry + sep))
      || globs.some((glob) => [path, directory, path.slice(agentDir.length + 1), directory.slice(agentDir.length + 1)].some((candidate) => glob.match(candidate)));
  };
  return { added, forced, excluded };
}

function discoverSkills({ home, cwd, env, serverEnv }: AgentCommandContext): SlashCommand[] {
  const agentDir = agentDirectory(home, env, serverEnv);
  const settings = plainObject(readJson(join(agentDir, "settings.json")));
  const listed = settingsSkills(home, agentDir, settings);
  const user = [...recursive(join(agentDir, "skills")), ...recursive(join(home, ".agents", "skills")), ...listed.added].filter((skill) => !listed.excluded(skill.path));
  const result = asCommands([...user, ...listed.forced], "user");
  if (cwd && projectTrusted(agentDir, settings, cwd)) {
    for (const directory of ancestorsToRepoRoot(cwd, home)) {
      result.push(...asCommands(recursive(join(directory, ".pi", "skills")), "project"), ...asCommands(recursive(join(directory, ".agents", "skills")), "project"));
    }
  }
  return result;
}

export const source: AgentCommandSource = {
  // Extension and package commands are runtime-only and are not listed; typed commands still send
  // through the terminal and receive an unknown outcome.
  // The upstream quit description uses `${APP_NAME}`; its pinned app name is "pi".
  pin: "1.3.0",
  builtins: PI_BUILTINS,
  descriptions: PI_DESCRIPTIONS,
  forms: PI_FORMS,
  terminalBound: PI_TERMINAL_BOUND,
  agentHidden: PI_AGENT_HIDDEN,
  discover(ctx) {
    // pi's packages and extension commands stay out: no file scan can know them, and they are in
    // the terminal's own `/` menu either way
    const { home, cwd } = ctx;
    const agentDir = agentDirectory(home, ctx.env, ctx.serverEnv);
    const trusted = cwd !== null && cwd !== undefined && projectTrusted(agentDir, plainObject(readJson(join(agentDir, "settings.json"))), cwd);
    return [
      ...piTemplates(join(agentDir, "prompts"), "user"),
      ...(trusted && existsSync(join(cwd, ".pi", "prompts")) ? piTemplates(join(cwd, ".pi", "prompts"), "project") : []),
      ...discoverSkills(ctx),
    ];
  },
};
