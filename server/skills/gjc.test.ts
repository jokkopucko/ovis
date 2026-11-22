import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";
import type { CommandForm } from "../../shared/protocol.ts";
import { source } from "./gjc.ts";

const roots: string[] = [];
const PINNED_GJC_BUILTINS = [
  "aside", "import-session", "notify", "settings", "language", "theme", "pet", "goal", "model", "effort",
  "fast", "routing", "export", "copy", "dump", "session", "jobs", "transcript", "context", "progress",
  "usage", "credential", "changelog", "tutorial", "help", "hotkeys", "tools", "mcp", "agents", "extensions",
  "monitors", "tree", "fork", "provider", "login", "logout", "ssh", "clear", "new", "drop", "compact",
  "handoff", "contribute-pr", "star", "unstar", "resume", "sessions", "btw", "retry", "background", "debug",
  "memory", "rename", "move", "exit",
];
const PINNED_GJC_TUI_ONLY = [
  "settings", "language", "theme", "pet", "goal", "copy", "tutorial", "help", "hotkeys", "mcp", "agents",
  "extensions", "monitors", "tree", "fork", "login", "logout", "new", "drop", "resume", "sessions", "btw",
  "retry", "background", "debug", "exit", "transcript",
];
const PINNED_GJC_ACTIVE_BUILTINS = PINNED_GJC_BUILTINS.filter(
  (name) => name !== "agents" && (process.platform === "linux" || name !== "import-session"),
);
const PINNED_GJC_ACTIVE_TUI_ONLY = PINNED_GJC_TUI_ONLY.filter((name) => PINNED_GJC_ACTIVE_BUILTINS.includes(name));
const PINNED_GJC_DESCRIPTIONS = {
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
  drop: "Delete the current session and start a new one",
  compact: "Compact context and continue this session",
  handoff: "Generate a handoff and continue in a new session",
  "contribute-pr": "Dump redacted session context and write a worker prompt for a separate terminal",
  star: "Star the current session for easier discovery",
  unstar: "Remove the star from the current session",
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
const PINNED_GJC_ACTIVE_DESCRIPTIONS = Object.fromEntries(
  PINNED_GJC_ACTIVE_BUILTINS.map((name) => [name, PINNED_GJC_DESCRIPTIONS[name as keyof typeof PINNED_GJC_DESCRIPTIONS]]),
);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "gjc-skills-"));
  roots.push(home);
  const cwd = join(home, "repo", "nested");
  const agentDir = join(home, "relocated");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, "repo", ".git"));
  const put = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const skill = (root: string, directory: string, name = directory): void => {
    put(join(root, directory, "SKILL.md"), `---\n${name ? `name: ${name}\n` : ""}description: First sentence. More detail for the tooltip.\n---\nBody\n`);
  };
  const config = (yaml: string): void => put(join(agentDir, "config.yml"), yaml);
  const commands = (env = [`GJC_CODING_AGENT_DIR=${agentDir}`], version?: string) =>
    paneCommands("gjc", cwd, home, { environ: env }, version);
  return { home, cwd, agentDir, put, skill, config, commands };
}

describe("gjc discovery", () => {
  it("reads the pane's relocated skills, commands and YAML settings", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "profiles", "active", "agent", "skills"), "chosen");
    f.skill(join(f.home, ".gjc", "agent", "skills"), "wrong-home");
    f.skill(join(f.home, "repo", ".gjc", "skills"), "untrusted");
    f.put(join(f.agentDir, "profiles", "active", "agent", "commands", "omg:setup.md"), "---\ndescription: Inspect installation\n---\nRun\n");
    f.config("profile: active\nskills:\n  trustProjectSkills: false\n");
    const commands = f.commands();
    expect(commands).toContainEqual(expect.objectContaining({ name: "skill:chosen", description: "First sentence. More detail for the tooltip.", source: "skill", origin: "user" }));
    expect(commands).toContainEqual(expect.objectContaining({ name: "omg:setup", description: "Inspect installation", source: "user" }));
    expect(commands.map((command) => command.name)).not.toContain("skill:wrong-home");
    expect(commands.map((command) => command.name)).not.toContain("skill:untrusted");
  });

  it("keeps nearest project skills ahead of user and distant duplicates", () => {
    const f = fixture();
    f.skill(join(f.cwd, ".gjc", "skills"), "near", "duplicate");
    f.skill(join(f.home, "repo", ".gjc", "skills"), "far", "duplicate");
    f.skill(join(f.agentDir, "skills"), "user", "duplicate");
    f.skill(join(f.home, ".gjc", "skills"), "outside");
    f.skill(join(f.home, "repo", ".gjc", "skills"), "root-only");
    f.put(join(f.cwd, ".gjc", "commands", "review.md"), "---\ndescription: Near\n---\n");
    f.put(join(f.agentDir, "commands", "review.md"), "---\ndescription: User\n---\n");
    const commands = f.commands();
    expect(commands.filter((command) => command.name === "skill:duplicate")).toMatchObject([
      { name: "skill:duplicate", description: "First sentence. More detail for the tooltip.", source: "skill", origin: "project" },
    ]);
    expect(commands.find((command) => command.name === "review")).toMatchObject({ description: "Near", source: "project" });
    expect(commands.find((command) => command.name === "skill:root-only")?.origin).toBe("project");
  });

  it.each(["trustProjectSkills", "enablePiProject"])("hides project skills when %s is false", (setting) => {
    const f = fixture();
    f.skill(join(f.cwd, ".gjc", "skills"), "project");
    f.skill(join(f.agentDir, "skills"), "user");
    f.config(`skills:\n  ${setting}: false\n`);
    const skills = f.commands().filter((command) => command.source === "skill");
    expect(skills.some((command) => command.origin === "project")).toBe(false);
    expect(skills.some((command) => command.name === "skill:user")).toBe(true);
  });

  it("hides all user roots when enablePiUser is false", () => {
    const f = fixture();
    for (const root of [join(f.agentDir, "skills"), join(f.home, ".gjc", "skills"), join(f.home, "custom")]) f.skill(root, "user");
    f.skill(join(f.cwd, ".gjc", "skills"), "project");
    f.config("skills:\n  enablePiUser: false\n  customDirectories: ['~/custom']\n");
    const skills = f.commands().filter((command) => command.source === "skill");
    expect(skills.some((command) => command.origin === "user")).toBe(false);
    expect(skills.some((command) => command.name === "skill:project")).toBe(true);
    expect(skills.filter((command) => command.origin === "bundled")).toHaveLength(4);
  });

  it("keeps bundled skills and commands when filesystem skills are disabled", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "user");
    f.put(join(f.agentDir, "commands", "review.md"), "Review\n");
    f.config("skills:\n  enabled: false\n");
    const commands = f.commands();
    expect(commands.filter((command) => command.origin === "bundled").map((command) => command.name).sort()).toEqual([
      "skill:autoresearch", "skill:deep-interview", "skill:ralplan", "skill:ultragoal",
    ]);
    expect(commands.some((command) => command.name === "skill:user")).toBe(false);
    expect(commands.some((command) => command.name === "review")).toBe(true);
  });

  it("marks tree as terminal-bound and annotates builtin forms", () => {
    expect(source.builtins).toContain("tree");
    expect(source.terminalBound).toEqual(["tree"]);
    expect(source.forms?.tree).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.model?.[0]).toEqual({ match: "bare", interaction: "dialog", dialog: "fallback-gjc-menu" });
    expect(source.forms?.model?.[1]).toEqual({ match: "other", interaction: "none" });
    expect(source.forms?.effort?.[0]).toEqual({ match: "bare", interaction: "dialog", dialog: "fallback-gjc-menu" });
    expect(source.forms?.effort?.[1]).toEqual({ match: "other", interaction: "none" });
    expect(source.forms?.handoff).toEqual([{ match: "bare", interaction: "none" }]);
    expect(source.forms?.btw).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.goal).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.language).toEqual([{ match: "bare", interaction: "terminal" }]);
  });

  it("emits tree catalog metadata", () => {
    expect(fixture().commands().find((command) => command.name === "tree")).toMatchObject({
      visibility: "terminal",
      provenance: { transport: "static" },
    });
  });

  it("emits model and effort rows with their fallback selector forms", () => {
    const commands = fixture().commands();
    for (const name of ["model", "effort"]) {
      expect(commands.find((command) => command.name === name)).toMatchObject({
        source: "builtin",
        forms: [
          { match: "bare", interaction: "dialog", dialog: "fallback-gjc-menu" },
          { match: "other", interaction: "none" },
        ],
      });
    }
  });

  it("marks every pinned handleTui-only command terminal", () => {
    const commands = fixture().commands();
    expect(commands.some((command) => command.name === "agents")).toBe(false);
    for (const name of PINNED_GJC_ACTIVE_TUI_ONLY) {
      expect(commands.find((command) => command.name === name)?.forms).toEqual([
        { match: "bare", interaction: "terminal" },
      ]);
    }
  });

  it("reads project commands only from cwd and user commands from active profile", () => {
    const f = fixture();
    f.put(join(f.home, "repo", ".gjc", "commands", "ancestor.md"), "Ancestor\n");
    f.put(join(f.cwd, ".gjc", "commands", "local.md"), "Local\n");
    f.put(join(f.agentDir, "profiles", "active", "agent", "commands", "profile.md"), "Profile\n");
    f.skill(join(f.agentDir, "profiles", "active", "agent", "skills"), "profile-skill");
    f.config("profile: active\n");
    const commands = f.commands();
    expect(commands.map((command) => command.name)).toContain("local");
    expect(commands.map((command) => command.name)).toContain("profile");
    expect(commands.map((command) => command.name)).not.toContain("ancestor");
    expect(commands.find((command) => command.name === "local")?.id).toBe(
      realpathSync(join(f.cwd, ".gjc", "commands", "local.md")),
    );
    expect(commands.find((command) => command.name === "skill:profile-skill")?.id).toBe(
      realpathSync(join(f.agentDir, "profiles", "active", "agent", "skills", "profile-skill", "SKILL.md")),
    );
  });

  it("honors skill trust, include, ignore and disabled extension settings", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "allowed");
    f.skill(join(f.agentDir, "skills"), "ignored");
    f.skill(join(f.home, "repo", ".gjc", "skills"), "project");
    f.config("disabledExtensions: ['skill:allowed']\nskills:\n  includeSkills: ['allowed', 'ignored']\n  ignoredSkills: ['ignored']\n  trustProjectSkills: false\n");
    const skills = f.commands().filter((command) => command.source === "skill");
    expect(skills.map((command) => command.name)).toEqual([
      "skill:autoresearch", "skill:deep-interview", "skill:ralplan", "skill:ultragoal",
    ]);
  });

  it("honors trustUserSkills independently of project skill trust", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "personal");
    f.config("skills:\n  trustUserSkills: false\n");
    expect(f.commands().map((command) => command.name)).not.toContain("skill:personal");
  });

  it("ignores HUD YAML and defaults when agent YAML is invalid", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "user");
    f.skill(join(f.cwd, ".gjc", "skills"), "project");
    f.put(join(f.home, ".gjc", "config.yml"), "skills:\n  enabled: false\n");
    f.config("skills: [invalid");
    const names = f.commands().map((command) => command.name);
    expect(names).toContain("skill:user");
    expect(names).toContain("skill:project");
  });

  it("honors PI fallbacks, GJC config precedence, legacy and custom directories", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "canonical");
    f.skill(join(f.home, ".custom-gjc", "skills"), "legacy");
    f.skill(join(f.home, ".custom-pi", "skills"), "pi-legacy");
    f.skill(join(f.home, ".gjc", "skills"), "old");
    f.skill(join(f.home, "extra"), "extra");
    f.config("skills:\n  customDirectories: ['~/extra']\n");
    const env = [`PI_CODING_AGENT_DIR=${f.agentDir}`, "GJC_CONFIG_DIR=.custom-gjc", "PI_CONFIG_DIR=.custom-pi"];
    const names = f.commands(env).map((command) => command.name);
    for (const name of ["canonical", "legacy", "old", "extra"]) expect(names).toContain(`skill:${name}`);
    expect(names).not.toContain("skill:pi-legacy");
    expect(f.commands([`PI_CODING_AGENT_DIR=${f.agentDir}`, "PI_CONFIG_DIR=.custom-pi"]).map((command) => command.name)).toContain("skill:pi-legacy");
  });

  it("uses GJC before PI and defaults to the gjc agent directory", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "skills"), "gjc");
    f.skill(join(f.home, "pi", "skills"), "pi");
    f.skill(join(f.home, ".gjc", "agent", "skills"), "default");
    const names = f.commands([`GJC_CODING_AGENT_DIR=${f.agentDir}`, `PI_CODING_AGENT_DIR=${join(f.home, "pi")}`]).map((command) => command.name);
    expect(names).toContain("skill:gjc");
    expect(names).not.toContain("skill:pi");
    expect(f.commands([]).map((command) => command.name)).toContain("skill:default");
  });

  it("requires descriptions, scans one level, follows links and reserves bundled names", () => {
    const f = fixture();
    const root = join(f.agentDir, "skills");
    f.skill(root, "directory", "named");
    f.skill(root, "fallback", "");
    f.skill(root, "deep/nested");
    f.skill(root, "deep-interview");
    f.put(join(root, "missing", "SKILL.md"), "---\nname: missing\n---\nBody\n");
    f.skill(join(f.home, "linked"), "target", "linked");
    symlinkSync(join(f.home, "linked", "target"), join(root, "link"));
    const skills = f.commands().filter((command) => command.source === "skill");
    const names = skills.map((command) => command.name);
    expect(names).toContain("skill:named");
    expect(names).toContain("skill:fallback");
    expect(names).toContain("skill:linked");
    expect(names).not.toContain("skill:nested");
    expect(names).not.toContain("skill:missing");
    expect(skills.filter((command) => command.name === "skill:deep-interview")).toHaveLength(1);
    expect(skills.find((command) => command.name === "skill:deep-interview")?.origin).toBe("bundled");
  });

  it("matches the active pinned v0.18.12 builtin registry", () => {
    // The upstream active registry removes quarantined agents and non-Linux import-session.
    expect([...source.builtins].sort()).toEqual([...PINNED_GJC_ACTIVE_BUILTINS].sort());
    expect(source.builtins).not.toContain("agents");
    expect(source.builtins.includes("import-session")).toBe(process.platform === "linux");
  });

  it("matches pinned registry descriptions in source and emitted rows", () => {
    const f = fixture();
    const commands = f.commands(undefined, "0.18.12").filter((command) => command.source === "builtin");
    expect(source.descriptions).toEqual(PINNED_GJC_ACTIVE_DESCRIPTIONS);
    expect(Object.fromEntries(commands.map((command) => [command.name, command.description]))).toEqual(PINNED_GJC_ACTIVE_DESCRIPTIONS);
    expect(commands.every((command) => command.provenance?.verified === true)).toBe(true);
  });

  const SELECTOR_FORMS: Record<string, CommandForm[]> = {
    routing: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
    provider: [{ match: "bare", interaction: "terminal" }, { match: { sub: "login" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
    session: [{ match: "bare", interaction: "unknown" }, { match: { sub: "delete" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  };

  it("emits all registry commands with their required interaction forms", () => {
    const commands = fixture().commands().filter((command) => command.source === "builtin");
    expect(commands.map((command) => command.name).sort()).toEqual([...PINNED_GJC_ACTIVE_BUILTINS].sort());
    const forms = new Map(commands.map((command) => [command.name, command.forms]));
    for (const name of PINNED_GJC_ACTIVE_TUI_ONLY) {
      expect(forms.get(name)).toEqual([{ match: "bare", interaction: "terminal" }]);
    }
    for (const name of PINNED_GJC_ACTIVE_BUILTINS.filter((name) => !PINNED_GJC_ACTIVE_TUI_ONLY.includes(name))) {
      const expected: CommandForm[] = name === "model" || name === "effort"
        ? [
            { match: "bare", interaction: "dialog", dialog: "fallback-gjc-menu" },
            { match: "other", interaction: "none" },
          ]
        : name === "handoff"
          ? [{ match: "bare", interaction: "none" }]
          : name in SELECTOR_FORMS ? SELECTOR_FORMS[name]!
            : [{ match: "bare", interaction: "unknown" }];
      expect(forms.get(name)).toEqual(expected);
    }
  });

  it("offers builtins and exactly the bundled skills over an empty home", () => {
    const f = fixture();
    const commands = f.commands();
    expect(commands.filter((command) => command.source === "builtin").map((command) => command.name).sort()).toEqual([...source.builtins].sort());
    expect(commands.filter((command) => command.source !== "builtin").map(({ name, source, origin }) => ({ name, source, origin }))).toEqual([
      { name: "skill:autoresearch", source: "skill", origin: "bundled" },
      { name: "skill:deep-interview", source: "skill", origin: "bundled" },
      { name: "skill:ralplan", source: "skill", origin: "bundled" },
      { name: "skill:ultragoal", source: "skill", origin: "bundled" },
    ]);
    expect(commands.filter((command) => command.origin === "bundled").every((command) => Boolean(command.id))).toBe(true);
  });
});

describe("gjc skill identity", () => {
  it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const home = mkdtempSync(join(tmpdir(), "gjc-identity-"));
    roots.push(home);
    const skills = join(home, ".gjc", "agent", "skills");
    mkdirSync(join(skills, "aliased"), { recursive: true });
    writeFileSync(join(skills, "aliased", "SKILL.md"), "---\nname: aliased\ndescription: Aliased skill\n---\n");
    symlinkSync(skills, join(home, ".gjc", "skills"), "dir");
    const rows = paneCommands("gjc", null, home).filter(({ name }) => name === "skill:aliased");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", origin: "user", id: realpathSync(join(skills, "aliased", "SKILL.md")) });
  });
});
