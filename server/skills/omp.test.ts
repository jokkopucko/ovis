import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./omp.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "omp-skills-"));
  fixtures.push(home);
  const repo = join(home, "repo"), cwd = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const agent = join(home, ".omp", "agent");
  const skill = (root: string, name: string, extra = "", desc = "A skill. More detail.") =>
    put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nInstructions.\n`);
  const commands = (env: string[] = []) => paneCommands("omp", cwd, home, { environ: env });
  return { home, repo, cwd, agent, skill, commands };
}

describe("omp command discovery", () => {
  it("skips dangling and directory .md links instead of failing the menu", () => {
    const f = fixture();
    put(join(f.agent, "commands/real.md"), "Real command");
    symlinkSync(join(f.home, "gone.md"), join(f.agent, "commands/dangling.md"));
    symlinkSync(join(f.agent, "commands"), join(f.agent, "commands/folder.md"), "dir");
    symlinkSync(join(f.home, "gone.md"), join(f.agent, "prompts-dangling.md"));
    mkdirSync(join(f.agent, "prompts"), { recursive: true });
    symlinkSync(join(f.home, "gone.md"), join(f.agent, "prompts/dangling.md"));
    const names = f.commands().filter((row) => row.source !== "builtin").map((row) => row.name);
    expect(names).toContain("real");
    expect(names.some((name) => name === "dangling" || name === "folder")).toBeFalse();
  });

  it("uses provider priority, ancestor boundaries and first names with realpath deduplication", () => {
    const f = fixture();
    f.skill(join(f.cwd, ".omp/skills"), "collision");
    f.skill(join(f.repo, ".omp/skills"), "ancestor");
    f.skill(join(f.agent, "skills"), "collision");
    f.skill(join(f.home, ".claude/skills"), "collision");
    f.skill(join(f.home, ".claude/skills"), "claude-user");
    f.skill(join(f.repo, ".agents/skills"), "agents-project");
    f.skill(join(f.home, ".agent/skills"), "agents-user");
    f.skill(join(f.home, ".codex/skills"), "codex-user");
    f.skill(join(f.cwd, ".opencode/skills"), "opencode-project");
    f.skill(join(f.home, ".config/opencode/skills"), "opencode-user");
    f.skill(join(f.cwd, ".github/skills"), "github-project");
    f.skill(join(f.agent, "managed-skills"), "managed");
    f.skill(join(f.home, ".omp/skills"), "outside-repo");
    f.skill(join(f.agent, "skills"), ".hidden");
    f.skill(join(f.agent, "skills"), "disabled", "enabled: false\n");
    f.skill(join(f.agent, "skills"), "missing", "", '""');
    f.skill(join(f.agent, "skills/group/deep"), "nested");
    put(join(f.agent, "skills/loose.md"), "---\ndescription: Loose\n---\n");
    symlinkSync(join(f.cwd, ".omp/skills/collision"), join(f.agent, "skills/linked"));
    const skills = f.commands().filter((row) => row.source === "skill");
    expect(skills.map((row) => row.name).sort()).toEqual([
      "agents-project", "agents-user", "ancestor", "claude-user", "codex-user", "collision",
      "github-project", "managed", "opencode-project", "opencode-user",
    ].map((name) => `skill:${name}`).sort());
    expect(skills.find((row) => row.name === "skill:collision")?.origin).toBe("project");
    expect(skills.find((row) => row.name === "skill:claude-user")?.origin).toBe("user");
  });

  it("honors skill source toggles, include and ignore globs, and custom overrides", () => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "native");
    f.skill(join(f.home, ".claude/skills"), "shared");
    f.skill(join(f.home, ".agents/skills"), "agent-user");
    f.skill(join(f.repo, ".agents/skills"), "agent-project");
    f.skill(join(f.agent, "managed-skills"), "managed");
    f.skill(join(f.home, "custom"), "shared", "", "Custom wins.");
    f.skill(join(f.home, "custom"), "ignored-one");
    put(join(f.agent, "config.yml"), "skills:\n  enablePiUser: false\n  enableAgentsUser: false\n  includeSkills: ['shared', 'managed', 'agent-*']\n  ignoredSkills: ['*-project', 'ignored-*']\n  customDirectories: ['~/custom']\n");
    const rows = f.commands().filter((row) => row.source === "skill");
    expect(rows.map((row) => row.name).sort()).toEqual(["skill:managed", "skill:shared"]);
    expect(rows.find((row) => row.name === "skill:shared")?.description).toBe("Custom wins.");
  });

  it.each(["enabled", "enableSkillCommands"])("does not register skill commands when %s is false", (key) => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "probe");
    put(join(f.agent, "config.yml"), `skills:\n  ${key}: false\n`);
    put(join(f.agent, "commands/deploy.md"), "Deploy the app");
    const commands = f.commands();
    expect(commands.some((row) => row.source === "skill")).toBeFalse();
    expect(commands.some((row) => row.name === "deploy")).toBeTrue();
  });

  it("keeps managed skills when every third-party toggle is disabled", () => {
    const f = fixture();
    f.skill(join(f.agent, "managed-skills"), "managed");
    f.skill(join(f.cwd, ".github/skills"), "third-party");
    put(join(f.agent, "config.yml"), "skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enablePiProject: false\n");
    expect(f.commands().filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:managed"]);
  });

  it("uses the pane environment for profiles and relocated agent and Claude roots", () => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "default");
    f.skill(join(f.home, ".omp/profiles/work/agent/skills"), "profile");
    f.skill(join(f.home, "moved/skills"), "moved");
    f.skill(join(f.home, "claude/skills"), "claude");
    expect(f.commands(["OMP_PROFILE=work"]).filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:profile"]);
    expect(f.commands(["PI_PROFILE=work"]).filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:profile"]);
    expect(f.commands([`PI_CODING_AGENT_DIR=${f.home}/moved`, `CLAUDE_CONFIG_DIR=${f.home}/claude`]).filter((row) => row.source === "skill").map((row) => row.name).sort()).toEqual(["skill:claude", "skill:moved"]);
  });

  it("falls back on malformed settings and applies the configured profile", () => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "default");
    put(join(f.agent, "config.yml"), "skills: [broken");
    expect(f.commands().some((row) => row.name === "skill:default")).toBeTrue();
    put(join(f.agent, "config.yml"), "profile: work\n");
    f.skill(join(f.home, ".omp/profiles/work/agent/skills"), "profile");
    expect(f.commands().filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:profile"]);
  });

  it("loads configured and installed plugins, with active registry versions and origins", () => {
    const f = fixture();
    const extension = join(f.home, "extension");
    put(join(f.agent, "config.yml"), `extensions:\n  - ${extension}\n`);
    f.skill(join(extension, "skills"), "extension");
    put(join(extension, "commands/plugin-command.md"), "Plugin command");
    const cache = join(f.home, ".claude/plugins/cache/market/pkg/1");
    f.skill(join(cache, "skills"), "market-skill");
    put(join(cache, "commands/check.md"), "Check changes");
    const disabled = join(f.home, "disabled-plugin");
    f.skill(join(disabled, "skills"), "disabled-plugin");
    put(join(f.home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      "pkg@market": [{ installPath: cache, scope: "user" }],
      "disabled@market": [{ installPath: disabled, enabled: false }],
    } }));
    const installed = join(f.home, ".omp/plugins/node_modules/installed");
    put(join(f.home, ".omp/plugins/omp-plugins.lock.json"), JSON.stringify({ plugins: { installed: { enabled: true } } }));
    put(join(installed, "package.json"), JSON.stringify({ omp: {} }));
    f.skill(join(installed, "skills"), "installed");
    const rows = f.commands();
    expect(rows.filter((row) => row.origin === "plugin").map((row) => row.name).sort()).toEqual(["skill:extension", "skill:installed", "skill:market-skill"]);
    expect(rows.find((row) => row.name === "pkg:check")?.source).toBe("user");
    expect(rows.some((row) => row.name === "plugin-command")).toBeTrue();
  });

  it("lists file commands and templates, reserves builtins and aliases, and preserves descriptions", () => {
    const f = fixture();
    put(join(f.cwd, ".omp/commands/deploy.md"), "---\ndescription: Deploy the app. Then check its health.\n---\nBody");
    put(join(f.agent, "prompts/review-docs.md"), "---\ndescription: Review documentation. Explain the changes.\n---\nBody");
    put(join(f.agent, "prompts/deploy.md"), "Hidden by the file command");
    put(join(f.agent, "prompts/model.md"), "Hidden even though the model screen is excluded");
    put(join(f.agent, "prompts/force:.md"), "Hidden alias");
    put(join(f.agent, "prompts/providers.md"), "Hidden setup alias");
    put(join(f.agent, "prompts/nested/deep.md"), "Deep prompt");
    put(join(f.home, ".agents/commands/team.md"), "Team command");
    put(join(f.home, ".codex/prompts/codex.md"), "---\nname: renamed\n---\nCodex prompt");
    put(join(f.cwd, ".github/prompts/github.prompt.md"), "GitHub prompt");
    const rows = f.commands();
    expect(rows.filter((row) => row.name === "deploy")).toMatchObject([{ name: "deploy", description: "Deploy the app. Then check its health.", source: "project" }]);
    expect(rows.find((row) => row.name === "review-docs")?.description).toBe("Review documentation. Explain the changes. (user)");
    expect(rows.find((row) => row.name === "deep")?.description).toBe("Deep prompt (user:nested)");
    expect(rows.some((row) => row.name === "team")).toBeTrue();
    expect(rows.some((row) => row.name === "renamed")).toBeTrue();
    expect(rows.some((row) => row.name === "github")).toBeTrue();
    expect(rows.some((row) => row.source !== "builtin" && ["help", "sessions", "model", "resume", "settings", "agents", "mcp", "plugins", "skills", "effort", "tree", "force:"].includes(row.name))).toBeFalse();
    expect(rows.filter((row) => row.source === "builtin").length).toBe(88);
    expect(rows.some((row) => row.name === "providers")).toBeFalse();
  });

  it("validates portable plugin skills and rejects invalid or escaping components", () => {
    const f = fixture();
    const plugin = join(f.home, "portable");
    put(join(f.agent, "config.yml"), `extensions:\n  - ${plugin}\n`);
    put(join(plugin, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable" }));
    f.skill(join(plugin, "skills"), "portable-skill");
    f.skill(join(plugin, "skills"), "invalid", "extra: true\n");
    f.skill(join(f.home, "outside"), "escaping");
    symlinkSync(join(f.home, "outside/escaping"), join(plugin, "skills/escaping"));
    const commands = f.commands();
    expect(commands.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:portable-skill"]);
    expect(commands.find((row) => row.name === "skill:portable-skill")?.origin).toBe("plugin");
  });

  it("honors command provider toggles, nested Claude aliases and gitignored files", () => {
    const f = fixture();
    put(join(f.home, ".claude/commands/team/check.md"), "Check changes");
    put(join(f.cwd, ".opencode/commands/hidden.md"), "Disabled command");
    put(join(f.cwd, ".omp/commands/ignored.md"), "Ignored command");
    put(join(f.repo, ".gitignore"), "ignored.md\n");
    put(join(f.agent, "config.yml"), "commands:\n  enableOpencodeProject: false\n");
    const names = f.commands().filter((row) => row.source !== "builtin").map((row) => row.name);
    expect(names).toEqual(["check", "team:check"]);
  });
});

// Canonical registry: can1357/oh-my-pi 53a0377d packages/coding-agent/src/slash-commands/builtin-*.ts
describe("omp builtin registry", () => {
  const formerExclusions = ["resume", "settings", "agents", "mcp", "plugins", "skills", "effort", "tree"];

  it("offers every former reserved-name exclusion as a terminal-bound builtin", () => {
    expect(source.builtins).toContain("model");
    for (const name of formerExclusions) {
      expect(source.builtins).toContain(name);
      expect(source.terminalBound).toContain(name);
    }
  });

  it("lists the former exclusions with visibility terminal", () => {
    const f = fixture();
    const rows = f.commands();
    for (const name of formerExclusions) expect(rows.find((row) => row.name === name)?.visibility).toBe("terminal");
  });

  it("marks handleTui-only commands and 18.5+ informational reports terminal", () => {
    for (const name of ["login", "logout", "new", "clear", "delete", "plan", "goal", "git", "hub", "exit", "quit",
      "changelog", "context", "tools", "hotkeys", "usage", "stats", "session", "dirs"]) {
      expect(source.terminalBound).toContain(name);
      expect(source.forms?.[name]?.every((form) => form.interaction === "terminal")).toBeTrue();
    }
    for (const name of ["compact", "btw", "handoff", "todo", "export", "switch"]) expect(source.terminalBound).not.toContain(name);
  });

  it("gives model, switch, handoff and btw their own forms", () => {
    expect(source.forms?.model).toEqual([{ match: "bare", interaction: "dialog", dialog: "omp-model" }, { match: "other", interaction: "none" }]);
    expect(source.forms?.switch).toEqual(source.forms?.model);
    expect(source.forms?.handoff).toEqual([
      { match: "bare", interaction: "dialog", dialog: "omp-handoff" }, { match: "other", interaction: "dialog", dialog: "omp-handoff" },
    ]);
    expect(source.forms?.btw).toEqual([{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }]);
    expect(source.forms?.modelpreset).toEqual([{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }]);
    expect(source.forms?.move).toEqual([{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }]);
    expect(source.forms?.todo).toContainEqual({ match: { sub: "edit" }, interaction: "terminal" });
    expect(source.forms?.advisor).toContainEqual({ match: { sub: "configure" }, interaction: "terminal" });
    expect(source.pin).toBe("18.12.3");
  });

  it("drops review, autoresearch and green unless an extension installs them", () => {
    const f = fixture();
    const bare = f.commands().map((row) => row.name);
    for (const name of ["review", "autoresearch", "green"]) expect(bare).not.toContain(name);
    const extension = join(f.home, "bundled");
    put(join(f.agent, "config.yml"), `extensions:\n  - ${extension}\n`);
    put(join(extension, "commands/review.md"), "Review changes");
    const rows = f.commands();
    expect(rows.find((row) => row.name === "review")?.source).toBe("user");
    expect(rows.some((row) => row.name === "green")).toBeFalse();
  });

  it("matches the registry names exactly", () => {
    for (const name of ["skillful", "ratchet", "modelpreset", "forget-approvals", "model", "switch"]) expect(source.builtins).toContain(name);
    expect(source.builtins).toContain("init");
  });
});

// Copied from can1357/oh-my-pi 53a0377db6845e0dae606146130766ec92d407fd packages/coding-agent/src/slash-commands/
// builtin-{modes,collaboration,session,lifecycle,marketplace,skills,control}.ts and seance.ts (SEANCE_SLASH_COMMAND,
// imported by builtin-lifecycle.ts). Where upstream computes the text (loop, effort: a trailing key hint; switch:
// the default alt+p), the stable part is kept. Drift fails the tests below.
const PINNED_DESCRIPTIONS: Readonly<Record<string, string>> = {
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
};
const PINNED_TUI_ONLY = ["settings","setup","plan","plan-review","vibe","goal","guided-goal","loop","queue","collab","join","leave","copy","open","hotkeys","extensions","agents","git","hub","branch","fork","tree","login","logout","new","clear","delete","resume","btw","tan","omfg","cleanse","debug","exit","restart","skills","live","record","pause","quit","seance"];

describe("omp pinned registry", () => {
  it("lists exactly the registry's names plus the embedded init", () => {
    expect(Object.keys(PINNED_DESCRIPTIONS).length).toBe(87);
    expect([...source.builtins].sort()).toEqual([...Object.keys(PINNED_DESCRIPTIONS), "init"].sort());
    expect(source.builtins.length).toBe(88);
  });

  it("lists seance as a terminal row, like every handleTui-only command except btw", () => {
    const f = fixture();
    const rows = f.commands();
    expect(rows.find((row) => row.name === "seance")?.visibility).toBe("terminal");
    for (const name of PINNED_TUI_ONLY.filter((item) => item !== "btw")) expect(source.terminalBound).toContain(name);
    expect(source.terminalBound).not.toContain("btw");
  });

  it("describes every builtin row as the pinned registry does", () => {
    const f = fixture();
    const rows = f.commands().filter((row) => row.source === "builtin");
    const drift = Object.entries(PINNED_DESCRIPTIONS).filter(([name, text]) => rows.find((row) => row.name === name)?.description !== text).map(([name]) => name);
    expect(drift).toEqual([]);
  });
});

describe("omp provider settings and namespaced skills", () => {
  it("drops a disabled provider's skills and commands, and lists them without the setting", () => {
    const f = fixture();
    f.skill(join(f.home, ".claude/skills"), "claude-user");
    f.skill(join(f.cwd, ".claude/skills"), "claude-project");
    f.skill(join(f.agent, "skills"), "native");
    put(join(f.home, ".claude/commands/claude-cmd.md"), "Claude command");
    const listed = f.commands().filter((row) => row.source === "skill").map((row) => row.name);
    expect(listed).toContain("skill:claude-user");
    expect(f.commands().some((row) => row.name === "claude-cmd")).toBeTrue();
    put(join(f.agent, "config.yml"), "disabledProviders: [claude]\n");
    const rows = f.commands();
    expect(rows.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:native"]);
    expect(rows.some((row) => row.name === "claude-cmd")).toBeFalse();
  });

  it("lets enabledProviders opt a foreign user source in over its toggle, but never over disabledProviders", () => {
    const f = fixture();
    f.skill(join(f.home, ".claude/skills"), "claude-user");
    f.skill(join(f.home, ".codex/skills"), "codex-user");
    put(join(f.agent, "config.yml"), "skills:\n  enableClaudeUser: false\n  enableCodexUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enablePiProject: false\nenabledProviders: [claude]\n");
    expect(f.commands().filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["skill:claude-user"]);
    put(join(f.agent, "config.yml"), "skills:\n  enableClaudeUser: false\nenabledProviders: [claude]\ndisabledProviders: [claude]\n");
    expect(f.commands().some((row) => row.name === "skill:claude-user")).toBeFalse();
  });

  it("keeps a same-name skill with different content as namespace/name and drops identical copies", () => {
    const f = fixture();
    f.skill(join(f.cwd, ".omp/skills"), "deploy", "", "Project deploy.");
    f.skill(join(f.home, ".claude/skills"), "deploy", "", "Claude deploy.");
    f.skill(join(f.agent, "skills"), "deploy", "", "Project deploy.");
    const plugin = join(f.home, "my-plugin");
    f.skill(join(plugin, "skills"), "deploy", "", "Plugin deploy.");
    put(join(f.agent, "config.yml"), `extensions:\n  - ${plugin}\n`);
    const rows = f.commands().filter((row) => row.source === "skill");
    expect(rows.map((row) => row.name).sort()).toEqual(["skill:claude/deploy", "skill:deploy", "skill:my-plugin/deploy"]);
    expect(rows.find((row) => row.name === "skill:deploy")?.description).toBe("Project deploy.");
  });

  it("drops a managed skill that an authored skill of the same name shadows, instead of namespacing it", () => {
    // extensibility/skills.ts: managed skills resolve last and defer to any enabled authored skill
    const f = fixture();
    f.skill(join(f.agent, "skills"), "deploy", "", "Authored deploy.");
    f.skill(join(f.agent, "managed-skills"), "deploy", "", "Managed deploy.");
    f.skill(join(f.agent, "managed-skills"), "learned", "", "Managed only.");
    const rows = f.commands().filter((row) => row.source === "skill");
    expect(rows.map((row) => row.name).sort()).toEqual(["skill:deploy", "skill:learned"]);
    expect(rows.find((row) => row.name === "skill:deploy")?.description).toBe("Authored deploy.");
  });

  it("describes /resume as omp's session resume, a terminal session selector, not a goal flow", () => {
    // builtin-lifecycle.ts: "Resume a different session", inlineHint [session id|@claude|@codex]; goal resume is /goal resume
    const f = fixture();
    const row = f.commands().find((command) => command.name === "resume");
    expect(row?.description).toBe("Resume a different session");
    expect(row?.visibility).toBe("terminal");
    expect(source.forms?.resume?.every((form) => form.interaction === "terminal")).toBeTrue();
  });

  it("gives skill, command and prompt rows the canonical path as id", () => {
    const f = fixture();
    f.skill(join(f.agent, "skills"), "native");
    put(join(f.agent, "commands/deploy.md"), "Deploy");
    put(join(f.agent, "prompts/ask.md"), "Ask");
    const rows = f.commands().filter((row) => row.source !== "builtin");
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.id).toBe(realpathSync(row.name === "skill:native" ? join(f.agent, "skills/native/SKILL.md") : join(f.agent, row.name === "deploy" ? "commands/deploy.md" : "prompts/ask.md")));
  });

  it("reads extension arrays from the effective config.yml, project over user", () => {
    const f = fixture();
    const user = join(f.home, "user-ext"), project = join(f.home, "project-ext");
    f.skill(join(user, "skills"), "from-user");
    f.skill(join(project, "skills"), "from-project");
    put(join(f.agent, "config.yml"), `extensions:\n  - ${user}\n`);
    expect(f.commands().filter((row) => row.origin === "plugin").map((row) => row.name)).toEqual(["skill:from-user"]);
    put(join(f.cwd, ".omp/config.yml"), `extensions:\n  - ${project}\n`);
    expect(f.commands().filter((row) => row.origin === "plugin").map((row) => row.name)).toEqual(["skill:from-project"]);
    put(join(f.agent, "config.yml"), "");
    put(join(f.cwd, ".omp/config.yml"), "");
    put(join(f.agent, "settings.json"), JSON.stringify({ extensions: [user] }));
    expect(f.commands().some((row) => row.origin === "plugin")).toBeFalse();
  });
});

describe("omp skill identity", () => {
  it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const f = fixture();
    f.skill(join(f.home, ".claude/skills"), "aliased");
    mkdirSync(join(f.home, ".agents"), { recursive: true });
    symlinkSync(join(f.home, ".claude/skills"), join(f.home, ".agents/skills"), "dir");
    const rows = f.commands().filter((row) => row.name.endsWith("aliased"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "skill:aliased", id: realpathSync(join(f.home, ".claude/skills/aliased/SKILL.md")) });
  });
});
