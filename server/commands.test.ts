import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneCommands } from "./commands.ts";
import { walkSkills } from "./skills/walk.ts";
import { AGENT_SOURCES } from "./skills/index.ts";
import type { AgentCommandSource } from "./skills/index.ts";
import type { SlashCommand } from "../shared/protocol.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("omo's loaded commands", () => {
  const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const skill = (root: string, name: string) => put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: From ${root}\n---\n`);
  const fixture = () => {
    const home = temp("omo-commands-");
    const agentDir = join(home, "custom-agent");
    const pluginDir = join(home, "plugin");
    return { home, agentDir, pluginDir, skillRoots: [join(agentDir, "skills"), join(home, ".agents", "skills"), join(pluginDir, "skills")] };
  };

  it("lists omo builtins and all three roots, with first-root precedence", () => {
    const { home, agentDir, pluginDir, skillRoots } = fixture();
    skillRoots.forEach((root, index) => { skill(root, `root-${index}`); skill(root, "shared"); });
    const commands = paneCommands("omo", null, home, { agentDir, pluginDir });
    const builtins = commands.filter((command) => command.source === "builtin").map((command) => command.name);
    expect(builtins).toEqual(["account", "answer", "btw", "changelog", "claude-account", "clone", "compact", "computer", "copy", "cursor-account", "dag", "diff", "doctor", "dream", "efforts", "exit", "export", "facts", "fallback", "fast", "favorite-models", "files", "fork", "goal", "gpt-account", "help", "history", "hotkeys", "import", "init", "ir", "keybindings", "login", "logout", "lookat", "loop", "mcp", "memfs", "memory", "memory-repository", "model", "name", "nested-agents", "new", "palace", "people", "quit", "reasoning", "recompile", "reflect", "reload", "reload-rules", "remember", "rename", "resume", "rules", "scoped-models", "search", "session", "sessions", "settings", "share", "sleeptime", "task-kill", "tasks", "thinking", "todo", "tree", "trust", "ttsr", "tui", "websearch"]);
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:root-0", "skill:root-1", "skill:root-2", "skill:shared"]);
    expect(commands.find((command) => command.name === "skill:shared")?.description).toBe(`From ${join(agentDir, "skills")}`);
    expect(commands.filter((command) => command.source === "skill").map((command) => [command.name, command.origin])).toEqual([["skill:root-0", "user"], ["skill:root-1", "user"], ["skill:root-2", "bundled"], ["skill:shared", "user"]]);
    expect(paneCommands("claude", null, home).some((command) => command.origin !== undefined)).toBe(false);
  });

  it("uses default roots without a plugin and excludes untrusted project skills", () => {
    const home = temp("omo-default-");
    const cwd = temp("omo-project-");
    skill(join(home, ".omo", "agent", "skills"), "personal");
    skill(join(home, ".agents", "skills"), "global");
    skill(join(cwd, ".omo", "skills"), "project");
    skill(join(cwd, ".agents", "skills"), "ancestor");
    const commands = paneCommands("omo", cwd, home);
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:global", "skill:personal"]);
    expect(paneCommands("omo", cwd, temp("omo-empty-")).every((command) => command.source === "builtin")).toBe(true);
    expect(paneCommands("pi", cwd, home).some((command) => command.name === "favorite-models")).toBe(false);
  });

  it("recurses in every root but stops at a declared skill", () => {
    const { home, agentDir, pluginDir, skillRoots } = fixture();
    skillRoots.forEach((root, index) => {
      skill(join(root, "group"), `inner-${index}`);
      skill(root, `outer-${index}`);
      skill(join(root, `outer-${index}`), `hidden-${index}`);
    });
    const commands = paneCommands("omo", null, home, { agentDir, pluginDir });
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:inner-0", "skill:inner-1", "skill:inner-2", "skill:outer-0", "skill:outer-1", "skill:outer-2"]);
  });

  it("applies pi and agents loose-markdown modes with parent-directory names", () => {
    const { home, agentDir, pluginDir, skillRoots } = fixture();
    for (const root of skillRoots) {
      put(join(root, "solo.md"), "---\ndescription: Root markdown\n---\n");
      put(join(root, "group", "inner.md"), "---\ndescription: Nested markdown\n---\n");
    }
    const commands = paneCommands("omo", null, home, { agentDir, pluginDir });
    expect(commands.filter((command) => command.source === "skill")).toMatchObject([
      { name: "skill:group", description: "Nested markdown", source: "skill", origin: "user" },
      { name: "skill:skills", description: "Root markdown", source: "skill", origin: "user" },
    ]);
  });

  it("rejects absent and blank descriptions, including loose markdown", () => {
    const { home, agentDir } = fixture();
    for (const filename of ["missing/SKILL.md", "blank/SKILL.md", "missing.md", "blank.md"]) {
      put(join(agentDir, "skills", filename), `---\nname: invalid\n${filename.startsWith("blank") ? 'description: "   "\\n' : ""}---\nBody is not a description.\n`);
    }
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill")).toEqual([]);
  });

  it("reads long UTF-8 frontmatter without interpreting the skill body", () => {
    const { home, agentDir } = fixture();
    const description = "한".repeat(3000);
    put(join(agentDir, "skills", "long", "SKILL.md"), `---\ndescription: ${description}\n---\nname: body-is-not-metadata\n`);
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill")).toMatchObject([
      { name: "skill:long", description, source: "skill", origin: "user" },
    ]);
  });

  it("honours root and nested ignores without hiding sibling paths", () => {
    const { home, agentDir } = fixture();
    const root = join(agentDir, "skills");
    skill(root, "hidden");
    skill(join(root, "group"), "secret");
    skill(join(root, "other"), "secret");
    put(join(root, ".gitignore"), "hidden/\n");
    put(join(root, "group", ".gitignore"), "secret/\n");
    const commands = paneCommands("omo", null, home, { agentDir });
    expect(commands.filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:secret"]);
    expect(commands.find((command) => command.name === "skill:secret")?.description).toBe(`From ${join(root, "other")}`);
  });

  it("re-includes an allowed directory and its contents after a wildcard ignore", () => {
    const { home, agentDir } = fixture();
    const root = join(agentDir, "skills");
    skill(root, "keep");
    skill(root, "hidden");
    put(join(root, ".ignore"), "*\n!keep/\n!keep/**\n");
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:keep"]);
  });

  it("follows skill links and skips broken links, cycles, hidden directories and node_modules", () => {
    const { home, agentDir } = fixture();
    const root = join(agentDir, "skills");
    const shared = temp("omo-linked-");
    skill(shared, "linked");
    mkdirSync(root, { recursive: true });
    symlinkSync(join(shared, "linked"), join(root, "alias"), "dir");
    symlinkSync(join(shared, "absent"), join(root, "broken"), "dir");
    symlinkSync(".", join(root, "cycle"), "dir");
    skill(join(root, ".hidden"), "hidden");
    skill(join(root, "node_modules"), "dependency");
    skill(root, "fd-hidden");
    put(join(root, ".fdignore"), "fd-hidden/\n");
    expect(paneCommands("omo", null, home, { agentDir }).filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["skill:linked"]);
  });
});

describe("paneCommands", () => {
  it("returns sorted built-ins for supported agents and none for unknown agents", () => {
    const claude = paneCommands("claude", null, temp("commands-home-"));
    expect(claude.some((command) => command.name === "clear" && command.source === "builtin")).toBeTrue();
    expect(claude.map((command) => command.name)).toEqual([...claude.map((command) => command.name)].sort());
    expect(paneCommands("unknown", "/tmp")).toEqual([]);
    expect(paneCommands(null, "/tmp")).toEqual([]);
  });

  it("offers Claude's /goal with the argument it takes", () => {
    const goal = paneCommands("claude", null, temp("commands-home-")).find((command) => command.name === "goal");
    expect(goal?.source).toBe("builtin");
    expect(goal?.description.startsWith("[condition|clear] — ")).toBeTrue();
    expect(paneCommands("codex", null, temp("commands-home-")).some((command) => command.name === "goal")).toBeTrue();
  });

  it("loads user and nested project Claude commands with descriptions", () => {
    const home = temp("commands-home-");
    const cwd = temp("commands-project-");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".claude", "commands", "team"), { recursive: true });
    writeFileSync(join(home, ".claude", "commands", "deploy.md"), "---\ndescription: Deploy safely\n---\nignored body\n");
    writeFileSync(join(cwd, ".claude", "commands", "team", "review.md"), "\nReview this project thoroughly\nMore detail");

    const commands = paneCommands("claude", cwd, home);
    expect(commands).toContainEqual(expect.objectContaining({ name: "deploy", description: "Deploy safely", source: "user" }));
    expect(commands).toContainEqual(expect.objectContaining({ name: "team:review", description: "Review this project thoroughly", source: "project" }));
  });

  it("stops the project walk at the home it is given, not the server's own", () => {
    const root = temp("commands-given-home-");
    const home = join(root, "home");
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    writeFileSync(join(root, ".claude", "commands", "above-home.md"), "Above the home\n");
    expect(paneCommands("claude", cwd, home).map((command) => command.name)).not.toContain("above-home");
  });

  it("falls back to USERPROFILE when HOME is not set in default home resolution, on Windows", () => {
    const userProfile = temp("commands-userprofile-");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    delete process.env.HOME;
    process.env.USERPROFILE = userProfile;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mkdirSync(join(userProfile, ".agents", "skills", "win-skill"), { recursive: true });
      writeFileSync(join(userProfile, ".agents", "skills", "win-skill", "SKILL.md"), "---\nname: win-skill\ndescription: Discovered via USERPROFILE\n---\n");
      const commands = paneCommands("omo", null);
      expect(commands.some((command) => command.name === "skill:win-skill")).toBeTrue();
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

describe("skills and plugins", () => {
  const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

  it("offers linked skills and commands while skipping broken links and cycles", () => {
    const home = temp("linked-home-");
    const cwd = temp("linked-project-");
    const shared = temp("linked-resources-");
    write(join(shared, "skill", "SKILL.md"), "---\ndescription: Shared skill\n---\n");
    write(join(shared, "review.md"), "Shared review\n");
    write(join(shared, "team", "check.md"), "Shared check\n");
    symlinkSync(".", join(shared, "team", "cycle"), "dir");
    const plugin = join(home, "plugin");
    for (const root of [join(home, ".claude"), join(cwd, ".claude"), join(home, ".codex"), join(cwd, ".codex"), join(home, ".agents"), join(home, ".pi", "agent"), plugin]) {
      const skills = join(root, "skills");
      mkdirSync(skills, { recursive: true });
      symlinkSync(join(shared, "skill"), join(skills, "linked"), "dir");
      symlinkSync(join(shared, "missing"), join(skills, "broken"), "dir");
      symlinkSync("cycle", join(skills, "cycle"), "dir");
    }
    for (const commands of [join(home, ".claude", "commands"), join(cwd, ".claude", "commands"), join(home, ".codex", "prompts"), join(plugin, "commands")]) {
      mkdirSync(commands, { recursive: true });
      symlinkSync(join(shared, "review.md"), join(commands, "review.md"));
      symlinkSync(join(shared, "missing.md"), join(commands, "broken.md"));
      symlinkSync("cycle.md", join(commands, "cycle.md"));
      symlinkSync(join(shared, "team"), join(commands, "team"), "dir");
      symlinkSync(join(shared, "team"), join(commands, "alias"), "dir");
      symlinkSync(".", join(commands, "cycle"), "dir");
    }
    write(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: plugin }] } }));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "tools@market": true } }));

    expect(paneCommands("claude", cwd, home).filter((command) => command.source !== "builtin")).toMatchObject([
      { name: "alias:check", description: "Shared check", source: "user" },
      { name: "linked", description: "Shared skill", source: "skill", origin: "user" },
      { name: "review", description: "Shared review", source: "user" },
      { name: "team:check", description: "Shared check", source: "user" },
      { name: "tools:alias:check", description: "Shared check", source: "plugin" },
      { name: "tools:linked", description: "Shared skill", source: "skill", origin: "plugin" },
      { name: "tools:review", description: "Shared review", source: "plugin" },
      { name: "tools:team:check", description: "Shared check", source: "plugin" },
    ]);
    expect(paneCommands("codex", cwd, home, {}, "0.117.0").filter((command) => command.source !== "builtin")).toMatchObject([
      { name: "linked", description: "Shared skill", source: "skill", trigger: "$", origin: "project" },
      { name: "prompts:review", description: "Shared review", source: "user" },
    ]);
    const previousPiAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = join(home, ".pi", "agent");
    try {
      expect(paneCommands("pi", null, home).filter((command) => command.source !== "builtin")).toMatchObject([
        { name: "skill:linked", description: "Shared skill", source: "skill", origin: "user" },
      ]);
    } finally {
      if (previousPiAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previousPiAgentDir;
    }
  });

  it("offers Claude's skills, user and project, and the enabled plugins' skills and commands", () => {
    const home = temp("skills-home-");
    const cwd = temp("skills-cwd-");
    write(join(home, ".claude", "skills", "patina", "SKILL.md"), "---\nname: patina\ndescription: Rewrite AI prose\n---\n");
    write(join(home, ".claude", "skills", "notes", "README.md"), "no SKILL.md: not a skill");
    write(join(cwd, ".claude", "skills", "deploy", "SKILL.md"), "---\ndescription: Ship it\n---\n");
    const plugin = join(home, ".claude", "plugins", "cache", "market", "hud", "1.0.0");
    write(join(plugin, "skills", "setup", "SKILL.md"), "---\nname: setup\ndescription: Configure the HUD\n---\n");
    write(join(plugin, "commands", "configure.md"), "---\ndescription: Configure options\n---\n");
    const off = join(home, ".claude", "plugins", "cache", "market", "off", "1.0.0");
    write(join(off, "skills", "hidden", "SKILL.md"), "---\nname: hidden\n---\n");
    write(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "hud@market": [{ installPath: plugin }], "off@market": [{ installPath: off }] } }));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "hud@market": true, "off@market": false } }));
    const extra = paneCommands("claude", cwd, home).filter((command) => command.source === "skill" || command.source === "plugin");
    expect(extra).toMatchObject([
      { name: "deploy", description: "Ship it", source: "skill", origin: "project" },
      { name: "hud:configure", description: "Configure options", source: "plugin" },
      { name: "hud:setup", description: "Configure the HUD", source: "skill", origin: "plugin" },
      { name: "patina", description: "Rewrite AI prose", source: "skill", origin: "user" },
    ]);
  });

  it("passes a long or multi-line description on whole: the menu shortens it, the tooltip shows it", () => {
    const home = temp("whole-home-");
    const long = "Builds the docs site, deploys it to a throwaway preview host and posts the address on the pull request it was asked from, then tears the host down once that pull request closes, however long that takes.";
    expect(long.length).toBeGreaterThanOrEqual(200);
    write(join(home, ".claude", "commands", "preview.md"), `---\ndescription: ${long}\n---\nbody\n`);
    write(join(home, ".claude", "skills", "patina", "SKILL.md"), "---\nname: patina\ndescription: >-\n  Rewrites AI prose in the house style.\n  Use when asked to deslop; never on code.\n---\n");
    write(join(home, ".claude", "skills", "literal", "SKILL.md"), "---\ndescription: |\n  Line one.\n  Line two.\n---\n");
    write(join(home, ".pi", "agent", "prompts", "review.md"), "---\ndescription: >-\n  Review the staged changes\n  one file at a time.\n---\nbody\n");
    const claude = paneCommands("claude", null, home);
    expect(claude.find((command) => command.name === "preview")?.description).toBe(long);
    expect(claude.find((command) => command.name === "patina")?.description).toBe("Rewrites AI prose in the house style. Use when asked to deslop; never on code.");
    expect(claude.find((command) => command.name === "literal")?.description).toBe("Line one.\nLine two.");
    expect(paneCommands("pi", null, home).find((command) => command.name === "review")?.description).toBe("Review the staged changes one file at a time.");
  });

  it("keeps the description line of a header that is not strict YAML", () => {
    const home = temp("loose-home-");
    const commands = join(home, ".claude", "commands");
    write(join(commands, "hint.md"), "---\nargument-hint: [system] [--source <path>]\ndescription: With hint\n---\nYou are the front door\n");
    write(join(commands, "colon.md"), "---\ndescription: Use when: the user asks\n---\n# Heading\n");
    write(join(commands, "sibling.md"), "---\nname: [broken\ndescription: \"Still here\"\n---\nBody line\n");
    write(join(commands, "none.md"), "---\nname: [broken\n---\nBody line\n");
    write(join(commands, "hash.md"), "---\ndescription: Close issue #102 and its PR\n---\nbody\n");
    write(join(commands, "escaped.md"), "---\ndescription: \"Say \\\"hi\\\" first\"\n---\nbody\n");
    const claude = paneCommands("claude", null, home);
    const said = (name: string) => claude.find((command) => command.name === name)?.description;
    expect(said("hint")).toBe("With hint");
    expect(said("colon")).toBe("Use when: the user asks");
    expect(said("sibling")).toBe("Still here");
    expect(said("none")).toBe("Body line");
    // a ` #` in a plain value is part of the text, not a YAML comment; a quoted value is YAML's
    expect(said("hash")).toBe("Close issue #102 and its PR");
    expect(said("escaped")).toBe('Say "hi" first');
  });

  it("offers Codex's saved prompts as /prompts:<name> and its skills with $", () => {
    const home = temp("codex-home-");
    write(join(home, ".codex", "prompts", "review.md"), "Review the diff\n");
    write(join(home, ".codex", "skills", "deepinit", "SKILL.md"), "---\nname: deepinit\ndescription: Deep codebase initialization\n---\n");
    const extra = paneCommands("codex", null, home, {}, "0.117.0").filter((command) => command.source !== "builtin");
    expect(extra).toMatchObject([
      { name: "deepinit", description: "Deep codebase initialization", source: "skill", trigger: "$", origin: "user" },
      { name: "prompts:review", description: "Review the diff", source: "user" },
    ]);
  });
});

describe("catalog rows", () => {
  const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const SCAN = { transport: "scan", verified: false } as const;
  function withSource<T>(source: AgentCommandSource, run: (agent: string) => T): T {
    const agent = "catalog-test-agent";
    AGENT_SOURCES[agent] = source;
    try { return run(agent); } finally { delete AGENT_SOURCES[agent]; }
  }

  it("lets a Claude skill named like a builtin replace it, marked as shadowing it", () => {
    const home = temp("catalog-claude-");
    write(join(home, ".claude", "skills", "compact", "SKILL.md"), "---\nname: compact\ndescription: My compaction\n---\n");
    const rows = paneCommands("claude", null, home).filter((command) => command.name === "compact");
    expect(rows.map(({ source, shadows }) => ({ source, shadows }))).toEqual([{ source: "skill", shadows: "builtin" }]);
  });

  it("keeps Codex's $compact skill beside its /compact builtin: they are typed differently", () => {
    const home = temp("catalog-codex-");
    write(join(home, ".codex", "skills", "compact", "SKILL.md"), "---\nname: compact\ndescription: My compaction\n---\n");
    const rows = paneCommands("codex", null, home).filter((command) => command.name === "compact");
    expect(rows.map(({ source, trigger, shadows, provenance }) => ({ source, trigger, shadows, transport: provenance?.transport }))).toEqual([
      { source: "builtin", trigger: undefined, shadows: undefined, transport: "static" },
      { source: "skill", trigger: "$", shadows: undefined, transport: "scan" },
    ]);
  });

  it("keeps same-name rows with different ids and collapses the same file reached through a link", () => {
    const root = temp("catalog-files-");
    write(join(root, "a", "SKILL.md"), "a");
    write(join(root, "b", "SKILL.md"), "b");
    symlinkSync(join(root, "a"), join(root, "link"), "dir");
    const row = (dir: string): SlashCommand => ({ name: "same", description: dir, source: "skill", id: realpathSync(join(root, dir, "SKILL.md")) });
    const rows = withSource({ builtins: [], discover: () => [row("a"), row("link"), row("b")] }, (agent) => paneCommands(agent, null, root));
    expect(rows.map(({ description }) => description)).toEqual(["a", "b"]);
    const anonymous = withSource({ builtins: [], discover: () => [{ name: "same", description: "1", source: "skill" }, { name: "same", description: "2", source: "skill" }] }, (agent) => paneCommands(agent, null, root));
    expect(anonymous.map(({ description }) => description)).toEqual(["1", "2"]);
  });

  const sameNamedSkills = () => {
    const home = temp("catalog-walk-");
    const skill = "---\nname: shared\ndescription: One description\n---\n";
    write(join(home, "r1", "a", "SKILL.md"), skill);
    write(join(home, "r2", "b", "SKILL.md"), skill);
    mkdirSync(join(home, "r3"), { recursive: true });
    symlinkSync(join(home, "r1", "a"), join(home, "r3", "alias"), "dir");
    const walk = (root: string) => walkSkills(join(home, root), { depth: "recursive", looseMarkdown: "none", ignoreFiles: false, requireDescription: true });
    const walkAll = () => [...walk("r1"), ...walk("r2"), ...walk("r3")];
    return { home, a: realpathSync(join(home, "r1", "a", "SKILL.md")), b: realpathSync(join(home, "r2", "b", "SKILL.md")), walked: walkAll(), walkAll };
  };

  it("gives a walked skill its file's canonical path as id, the same through a link", () => {
    const { a, b, walked } = sameNamedSkills();
    expect(walked.map(({ name, id }) => [name, id])).toEqual([["shared", a], ["shared", b], ["shared", a]]);
  });

  it("collapses rows carrying the same walked id and keeps different files apart, however the scanner orders them", () => {
    const { home, a, b, walkAll } = sameNamedSkills();
    const origins = ["user", "project", "bundled"] as const;
    const rows = () => walkAll().map((skill, index): SlashCommand => ({ name: skill.name, description: skill.description, source: "skill", origin: origins[index], id: skill.id }));
    const listed = (discover: () => SlashCommand[]) => withSource({ builtins: [], discover }, (agent) => paneCommands(agent, null, home)).map(({ origin, id }) => [origin, id]);
    expect(listed(rows)).toEqual([["user", a], ["project", b]]);
    expect(listed(() => { const [first, second, third] = rows(); return [first!, third!, second!]; })).toEqual([["user", a], ["project", b]]);
  });

  it("never merges two different files of one name and description that a real scanner lists without ids", () => {
    const home = temp("catalog-pi-");
    const agentDir = join(home, ".pi", "agent");
    const skill = "---\nname: shared\ndescription: One description\n---\n";
    write(join(agentDir, "skills", "shared", "SKILL.md"), skill);
    write(join(home, "elsewhere", "shared.md"), skill);
    write(join(agentDir, "settings.json"), JSON.stringify({ skills: [join(home, "elsewhere", "shared.md")] }));
    const rows = paneCommands("pi", null, home, { environ: [`PI_CODING_AGENT_DIR=${agentDir}`] }).filter((command) => command.name === "skill:shared");
    expect(rows).toHaveLength(2);
  });

  it("keeps a builtin beside a same-name skill unless the source says skills override builtins", () => {
    const discover = (): SlashCommand[] => [{ name: "compact", description: "Mine", source: "skill", id: "/skills/compact/SKILL.md" }];
    const kept = withSource({ builtins: ["compact"], discover }, (agent) => paneCommands(agent, null, temp("catalog-")));
    expect(kept.map(({ source, shadows }) => [source, shadows])).toEqual([["builtin", undefined], ["skill", undefined]]);
    const replaced = withSource({ builtins: ["compact"], discover, skillsOverrideBuiltins: true }, (agent) => paneCommands(agent, null, temp("catalog-")));
    expect(replaced).toEqual([{ name: "compact", description: "Mine", source: "skill", id: "/skills/compact/SKILL.md", shadows: "builtin", forms: [{ match: "bare", interaction: "unknown" }], visibility: "offered", provenance: SCAN }]);
  });

  it("gives every row provenance, and an unannotated builtin an unknown bare form, offered", () => {
    const home = temp("catalog-provenance-");
    write(join(home, ".claude", "skills", "patina", "SKILL.md"), "---\ndescription: Rewrite prose\n---\n");
    write(join(home, ".claude", "commands", "deploy.md"), "Deploy\n");
    const rows = paneCommands("claude", null, home);
    expect(rows.every((command) => command.provenance !== undefined)).toBe(true);
    expect(rows.filter((command) => command.source !== "builtin").map(({ name, provenance }) => [name, provenance])).toEqual([["deploy", SCAN], ["patina", SCAN]]);
    expect(rows.find((command) => command.name === "clear")).toEqual({ name: "clear", description: "Clear the conversation", source: "builtin", forms: [{ match: "bare", interaction: "unknown" }], visibility: "offered", provenance: { transport: "static", verified: false } });
  });

  it("emits declared forms and lists terminal-bound and agent-hidden builtins with their visibility", () => {
    const source: AgentCommandSource = {
      builtins: ["model", "clear"], terminalBound: ["theme"], agentHidden: ["clear"],
      forms: { model: [{ match: "bare", interaction: "dialog", dialog: "model-picker" }, { match: "other", interaction: "none" }] },
      discover: () => [],
    };
    const rows = withSource(source, (agent) => paneCommands(agent, null, temp("catalog-")));
    expect(rows.map(({ name, visibility, forms }) => [name, visibility, forms])).toEqual([
      ["clear", "agent-hidden", [{ match: "bare", interaction: "unknown" }]],
      ["model", "offered", [{ match: "bare", interaction: "dialog", dialog: "model-picker" }, { match: "other", interaction: "none" }]],
      ["theme", "terminal", [{ match: "bare", interaction: "unknown" }]],
    ]);
  });

  it("verifies builtins only when the running version matches the pin by major.minor", () => {
    const source: AgentCommandSource = { builtins: ["clear"], pin: "2.1.0", discover: () => [{ name: "mine", description: "Mine", source: "skill", id: "mine" }] };
    const verified = (version: string | null | undefined) => withSource(source, (agent) => paneCommands(agent, null, temp("catalog-"), {}, version)).map(({ name, provenance }) => [name, provenance?.verified]);
    expect(verified("2.1.301")).toEqual([["clear", true], ["mine", false]]);
    expect(verified("2.2.0")).toEqual([["clear", false], ["mine", false]]);
    expect(verified("12.1.0")).toEqual([["clear", false], ["mine", false]]);
    expect(verified(null)).toEqual([["clear", false], ["mine", false]]);
    expect(verified(undefined)).toEqual([["clear", false], ["mine", false]]);
  });

  it("keeps the forms, visibility and provenance a scanner set, once per name and id", () => {
    const row: SlashCommand = { name: "share", description: "Share", source: "builtin", id: "share", forms: [{ match: "bare", interaction: "none" }], visibility: "terminal", provenance: { transport: "static", verified: true } };
    const rows = withSource({ builtins: [], discover: () => [row, { ...row }] }, (agent) => paneCommands(agent, null, temp("catalog-")));
    expect(rows).toEqual([row]);
  });

  it("passes the version to the scanner", () => {
    let seen: string | null | undefined = "unset";
    withSource({ builtins: [], discover: (ctx) => { seen = ctx.version; return []; } }, (agent) => paneCommands(agent, null, temp("catalog-"), {}, "0.162.1"));
    expect(seen).toBe("0.162.1");
  });
});

// Measured against pi 0.87.1: its `/` palette (the built-ins and their wording), and what a
// headless `get_commands` reports for resources planted in each folder pi reads.
describe("pi's slash commands", () => {
  const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const skill = (root: string, name: string, description: string) => put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);

  it("offers pi's own built-ins, in pi's words", () => {
    const commands = paneCommands("pi", null, temp("pi-empty-home-"));
    expect(commands.map((command) => command.name)).toContain("compact");
    expect(commands).toContainEqual(expect.objectContaining({
      name: "tree",
      visibility: "terminal",
      forms: [{ match: "bare", interaction: "terminal" }],
    }));
    expect(commands).toContainEqual(expect.objectContaining({ name: "quit", description: "Quit pi", source: "builtin" }));
    expect(commands.map((command) => command.name)).not.toContain("sessions");
    expect(commands.every((command) => command.source === "builtin")).toBeTrue();
  });

  it("offers the templates and skills pi loads from the person's own folders", () => {
    const home = temp("pi-home-");
    put(join(home, ".pi", "agent", "prompts", "review.md"), "---\ndescription: Review staged git changes\n---\nbody\n");
    put(join(home, ".pi", "agent", "prompts", "plain.md"), "First line wins when there is no frontmatter\n");
    skill(join(home, ".pi", "agent", "skills"), "pdf-tools", "Extract text from PDFs");
    skill(join(home, ".agents", "skills"), "from-agents", "Found under ~/.agents");

    const extra = paneCommands("pi", null, home).filter((command) => command.source !== "builtin");
    expect(extra).toMatchObject([
      { name: "plain", description: "First line wins when there is no frontmatter", source: "user" },
      { name: "review", description: "Review staged git changes", source: "user" },
      // a skill is a command under skill:, which is how pi names it and how it must be typed
      { name: "skill:from-agents", description: "Found under ~/.agents", source: "skill", origin: "user" },
      { name: "skill:pdf-tools", description: "Extract text from PDFs", source: "skill", origin: "user" },
    ]);
  });

  it("offers a template reached through a symbolic link", () => {
    // pi reads a prompt directory with readdir + stat, so a link to a .md file is a file to it and
    // the command is loaded. `entry.isFile()` on the directory entry asks the link itself, which
    // answers false, and the chat silently hid a command the agent would run — the common way to
    // keep one review prompt shared between a dotfiles repo and an agent dir
    const home = temp("pi-home-");
    const elsewhere = temp("pi-shared-");
    put(join(elsewhere, "review.md"), "---\ndescription: Review staged git changes\n---\nbody\n");
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
    symlinkSync(join(elsewhere, "review.md"), join(home, ".pi", "agent", "prompts", "review.md"));
    const commands = paneCommands("pi", null, home).filter((command) => command.source === "user");
    expect(commands).toMatchObject([{ name: "review", description: "Review staged git changes", source: "user" }]);
  });

  it("skips a prompt link that resolves to nothing or to a folder", () => {
    // a broken link is skipped by pi too (its stat throws), and a folder is not a template: a
    // conventional prompt directory loads its direct .md children and nothing below one, so
    // following a link to a folder would offer commands pi never loads
    const home = temp("pi-home-");
    const elsewhere = temp("pi-shared-");
    put(join(elsewhere, "deep.md"), "---\ndescription: nested under a linked folder\n---\n");
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
    symlinkSync(join(elsewhere, "gone.md"), join(home, ".pi", "agent", "prompts", "broken.md"));
    symlinkSync(elsewhere, join(home, ".pi", "agent", "prompts", "folder.md"));
    symlinkSync(join(elsewhere, "deep.md"), join(home, ".pi", "agent", "prompts", "ok.md"));
    const names = paneCommands("pi", null, home).filter((command) => command.source === "user").map((command) => command.name);
    expect(names).toEqual(["ok"]);
  });

  it("reads no deeper than pi does in a prompt directory", () => {
    const home = temp("pi-home-");
    put(join(home, ".pi", "agent", "prompts", "top.md"), "---\ndescription: a direct child\n---\n");
    // pi loads direct .md children of a conventional prompt directory and nothing below one
    put(join(home, ".pi", "agent", "prompts", "sub", "deep.md"), "---\ndescription: a nested one\n---\n");
    const names = paneCommands("pi", null, home).filter((command) => command.source === "user").map((command) => command.name);
    expect(names).toEqual(["top"]);
  });

  it("holds a project's own commands back, since pi gates them behind trust", () => {
    const home = temp("pi-home-");
    const cwd = temp("pi-project-");
    put(join(cwd, ".pi", "prompts", "proj-template.md"), "---\ndescription: a project template\n---\n");
    skill(join(cwd, ".pi", "skills"), "proj-skill", "A project skill");
    // offered only where pi would run them, and which folder pi calls the project is its own
    // decision behind ~/.pi/agent/trust.json: a listed command the agent refuses is worse than
    // one missing from the menu, so a project's resources stay in the terminal's menu
    const commands = paneCommands("pi", cwd, home);
    expect(commands.some((command) => command.source === "project")).toBeFalse();
    expect(commands.map((command) => command.name)).not.toContain("proj-template");
    expect(commands.map((command) => command.name)).not.toContain("skill:proj-skill");
  });

  it("leaves a folder with no pi resources at its built-ins", () => {
    expect(paneCommands("pi", temp("pi-cwd-"), temp("pi-home-")).every((command) => command.source === "builtin")).toBeTrue();
  });
});

// The catalog reads files above the skill roots; a FIFO named like one of them must not block the
// server. Discovery runs in a child with a deadline, since a blocking read would hang this process.
// Command Code's discovery reads settings a repository may commit; it must stay bounded however they
// are made. In a child with a deadline, since a blocking read or walk would hang this process.
describe.skipIf(process.platform === "win32")("Command Code discovery stays bounded", () => {
  const cmdInChild = (home: string, cwd: string) => {
    const script = `const { AGENT_SOURCES } = await import(${JSON.stringify(join(import.meta.dir, "skills", "index.ts"))});`
      + `console.log(JSON.stringify(AGENT_SOURCES.cmd.discover(${JSON.stringify({ home, cwd, repoRoot: null, env: null, roots: {}, version: null })}).map((row) => row.name)));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { timeout: 5_000, stdout: "pipe", stderr: "pipe" });
    return { exitCode: child.exitCode, names: child.exitCode === 0 ? JSON.parse(child.stdout.toString()) as string[] : [] };
  };
  const repoIn = (root: string) => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".commandcode"), { recursive: true });
    return repo;
  };

  it("skips a FIFO committed as the project's settings", () => {
    const repo = repoIn(temp("cmd-settings-fifo-"));
    expect(Bun.spawnSync(["mkfifo", join(repo, ".commandcode", "settings.json")]).exitCode).toBe(0);
    const result = cmdInChild(temp("cmd-home-"), repo);
    expect(result.exitCode).toBe(0);
    expect(result.names).toContain("agent-browser");
  });

  it("walks a configured skill folder whose sibling links share folders in bounded time", () => {
    const repo = repoIn(temp("cmd-lattice-"));
    const level = (index: number) => join(repo, "lattice", `l${index}`);
    for (let index = 0; index <= 20; index += 1) mkdirSync(level(index), { recursive: true });
    for (let index = 0; index < 20; index += 1) for (const name of ["a", "b"]) symlinkSync(level(index + 1), join(level(index), name), "dir");
    writeFileSync(join(level(20), "SKILL.md"), "---\nname: deep-skill\ndescription: Deep\n---\n");
    writeFileSync(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./lattice/l0"] }));
    const result = cmdInChild(temp("cmd-home-"), repo);
    expect(result.exitCode).toBe(0);
    expect(result.names).toContain("deep-skill");
    writeFileSync(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: Array.from({ length: 1000 }, () => "./lattice/l0") }));
    const repeated = cmdInChild(temp("cmd-home-"), repo);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.names).toContain("deep-skill");
  });

  it("counts links back to an ancestor and every project folder up to the root against one budget", () => {
    const root = temp("cmd-flood-");
    const level = (index: number) => join(root, "lattice", `l${index}`);
    for (let index = 0; index <= 14; index += 1) mkdirSync(level(index), { recursive: true });
    for (let index = 0; index < 14; index += 1) for (const name of ["a", "b"]) symlinkSync(level(index + 1), join(level(index), name), "dir");
    for (let index = 0; index < 200; index += 1) symlinkSync(level(14), join(level(14), `self${index}`), "dir");
    const repo = repoIn(root);
    let cwd = repo;
    for (let depth = 0; depth < 24; depth += 1) {
      mkdirSync(join(cwd, ".commandcode"), { recursive: true });
      symlinkSync(level(0), join(cwd, ".commandcode", "skills"), "dir");
      symlinkSync(level(0), join(cwd, ".commandcode", "commands"), "dir");
      cwd = join(cwd, `p${depth}`);
      mkdirSync(cwd, { recursive: true });
    }
    expect(cmdInChild(temp("cmd-home-"), cwd).exitCode).toBe(0);
  });

  it("reads custom commands whose header is never closed in bounded time", () => {
    const home = temp("cmd-unclosed-");
    for (const name of ["one", "two", "three"]) {
      mkdirSync(join(home, ".commandcode", "commands"), { recursive: true });
      writeFileSync(join(home, ".commandcode", "commands", `${name}.md`), `---\n${"\n".repeat(65536)}---\nA normal command body.\n`);
    }
    const result = cmdInChild(home, temp("cmd-cwd-"));
    expect(result.exitCode).toBe(0);
    expect(result.names).toContain("three");
  });
});

it("reads a skill's declared name from a CRLF header", () => {
  const root = temp("crlf-skill-");
  mkdirSync(join(root, "folder"), { recursive: true });
  writeFileSync(join(root, "folder", "SKILL.md"), "---\r\nname: declared-name\r\ndescription: Declared\r\n---\r\nBody\r\n");
  const walked = walkSkills(root, { depth: "recursive", looseMarkdown: "none", ignoreFiles: false, requireDescription: false });
  expect(walked.map(({ name }) => name)).toEqual(["declared-name"]);
});

describe.skipIf(process.platform === "win32")("files that are not regular files", () => {
  const discoverInChild = (agent: string, args: Record<string, unknown>) => {
    const script = `const { AGENT_SOURCES } = await import(${JSON.stringify(join(import.meta.dir, "skills", "index.ts"))});`
      + `console.log(JSON.stringify(AGENT_SOURCES[${JSON.stringify(agent)}].discover(${JSON.stringify(args)}).map((row) => row.name)));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { timeout: 5_000, stdout: "pipe", stderr: "pipe" });
    return { exitCode: child.exitCode, names: child.exitCode === 0 ? JSON.parse(child.stdout.toString()) as string[] : [] };
  };
  const fifo = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  };

  it("skips a FIFO named like a Codex plugin manifest above a skill", () => {
    const home = temp("codex-fifo-");
    mkdirSync(join(home, ".agents", "skills", "shared"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: Shared.\n---\n");
    fifo(join(home, ".agents", "plugin.json"));
    const result = discoverInChild("codex", { home, cwd: null, repoRoot: null, env: null, roots: {}, version: null });
    expect(result.exitCode).toBe(0);
    expect(result.names).toContain("shared");
  });

  it("skips a FIFO named like an OmO project config above the pane's folder", () => {
    const root = temp("omo-fifo-");
    const home = join(root, "home");
    const cwd = join(root, "project");
    const pluginDir = join(root, "plugin");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(pluginDir, "skills", "bundled-x"), { recursive: true });
    writeFileSync(join(pluginDir, "skills", "bundled-x", "SKILL.md"), "---\nname: bundled-x\ndescription: Bundled.\n---\n");
    fifo(join(root, ".omo", "omo.jsonc"));
    const result = discoverInChild("omo", { home, cwd, repoRoot: cwd, env: null, roots: { pluginDir } });
    expect(result.exitCode).toBe(0);
    expect(result.names).toContain("skill:bundled-x");
  });
});
