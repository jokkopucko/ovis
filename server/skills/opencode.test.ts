import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { MAX_COMMAND_FILES, source } from "./opencode.ts";
import type { AgentCommandContext } from "./index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const skill = (path: string, name: unknown, description: unknown = "First sentence. Second sentence.", extra = "") =>
  put(join(path, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${extra}---\nBody\n`);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-menu-"));
  roots.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(repo, ".git"));
  return { root, home, repo, cwd, config: join(home, ".config", "opencode") };
}

describe("OpenCode's menu", () => {
  it("loads recursive native and external roots up to the repository boundary with origins", () => {
    const { root, home, repo, cwd, config } = fixture();
    skill(join(config, "skill", "nested", "native"), "native");
    skill(join(config, "skills", "plural"), "plural", "Description", "metadata:\n  opencode/slash: false\n");
    skill(join(home, ".claude", "skills", "claude"), "claude");
    skill(join(home, ".agents", "skills", "shared"), "shared");
    skill(join(repo, ".opencode", "skills", "project"), "project");
    skill(join(cwd, ".opencode", "skill", "local"), "local");
    skill(join(repo, ".claude", "skills", "external-project"), "external-project");
    skill(join(cwd, ".agents", "skills", "local-agents"), "local-agents");
    skill(join(root, ".opencode", "skills", "outside"), "outside");
    symlinkSync(join(config, "skills"), join(config, "skills", "loop"), "dir");
    const commands = paneCommands("opencode", cwd, home);
    expect(commands.filter((row) => row.source === "skill").map(({ name, origin }) => [name, origin])).toEqual([
      ["claude", "user"], ["customize-opencode", "bundled"], ["external-project", "project"],
      ["local", "project"], ["local-agents", "project"], ["native", "user"], ["plural", "user"], ["project", "project"], ["shared", "user"],
    ]);
  });

  it("omits every external root when the pane sets OPENCODE_DISABLE_EXTERNAL_SKILLS", () => {
    const { home, cwd, config } = fixture();
    skill(join(config, "skills", "native"), "native");
    for (const directory of [home, cwd]) {
      for (const kind of [".claude", ".agents"]) skill(join(directory, kind, "skills", `${kind.slice(1)}-external`), `${kind.slice(1)}-external`);
    }
    const commands = paneCommands("opencode", cwd, home, { environ: ["OPENCODE_DISABLE_EXTERNAL_SKILLS=1"] });
    expect(commands.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["customize-opencode", "native"]);
  });

  // v1 (packages/core skill discovery): the Claude flags gate only the .claude roots; .agents stays.
  for (const flag of ["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"]) {
    it(`omits only the Claude roots when the pane sets ${flag}`, () => {
      const { home, cwd, config } = fixture();
      skill(join(config, "skills", "native"), "native");
      for (const directory of [home, cwd]) {
        for (const kind of [".claude", ".agents"]) skill(join(directory, kind, "skills", `${kind.slice(1)}-external`), `${kind.slice(1)}-external`);
      }
      const commands = paneCommands("opencode", cwd, home, { environ: [`${flag}=1`] });
      expect(commands.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["agents-external", "customize-opencode", "native"]);
    });
  }

  it("honors the pane config directory rather than the server environment", () => {
    const { root, home, config } = fixture();
    skill(join(config, "skills", "default"), "default");
    const custom = join(root, "custom");
    skill(join(custom, "skill", "custom"), "custom");
    put(join(custom, "commands", "check.md"), "---\ndescription: Check\n---\nRun checks");
    const commands = paneCommands("opencode", null, home, { environ: [`OPENCODE_CONFIG_DIR=${custom}`] });
    expect(commands.filter((row) => row.source !== "builtin").map((row) => row.name)).toEqual(["check", "custom", "customize-opencode"]);
  });

  it("stops walking a command folder whose sibling links fan out, within the skill walk's bound", () => {
    const { root, home } = fixture();
    const custom = join(root, "custom");
    put(join(custom, "commands", "check.md"), "---\ndescription: Check\n---\nRun checks");
    // every level links twice to the next: 2^24 paths without a bound, so the old walk never ended
    const levels = 24;
    for (let level = 0; level < levels; level++) mkdirSync(join(custom, "commands", "lattice", `d${level}`), { recursive: true });
    for (let level = 0; level < levels - 1; level++) {
      for (const link of ["a", "b"]) symlinkSync(join(custom, "commands", "lattice", `d${level + 1}`), join(custom, "commands", "lattice", `d${level}`, link), "dir");
    }
    symlinkSync(join(custom, "commands", "lattice", "d0"), join(custom, "commands", "fan"), "dir");
    const commands = paneCommands("opencode", null, home, { environ: [`OPENCODE_CONFIG_DIR=${custom}`] });
    expect(commands.some((row) => row.name === "check")).toBe(true);
  }, 10_000);

  it("takes a bounded number of command files from links that name one file under many paths", () => {
    const { root, home } = fixture();
    const custom = join(root, "custom");
    const lattice = join(custom, "commands", "lattice");
    const levels = 12;
    for (let level = 0; level < levels; level++) mkdirSync(join(lattice, `d${level}`), { recursive: true });
    for (let level = 0; level < levels - 1; level++) {
      for (const link of ["a", "b"]) symlinkSync(join(lattice, `d${level + 1}`), join(lattice, `d${level}`, link), "dir");
    }
    const shared = join(root, "shared.md");
    writeFileSync(shared, `---\ndescription: Shared\n---\n${"x".repeat(64 * 1024)}`);
    for (let file = 0; file < 32; file++) symlinkSync(shared, join(lattice, `d${levels - 1}`, `c${file}.md`));
    const commands = paneCommands("opencode", null, home, { environ: [`OPENCODE_CONFIG_DIR=${custom}`] });
    expect(commands.filter((row) => row.name.startsWith("lattice/")).length).toBeLessThanOrEqual(MAX_COMMAND_FILES);
  }, 20_000);

  it("rejects invalid metadata without falling back to directory names", () => {
    const { home, config } = fixture();
    for (const [directory, name, desc] of [
      ["mismatch", "different", "Description"], ["missing", null, "Description"],
      ["Upper", "Upper", "Description"], ["bad--name", "bad--name", "Description"],
      ["long-description", "long-description", "x".repeat(1025)], ["not-string", "not-string", 7], ["a".repeat(65), "a".repeat(65), "Description"],
    ] as const) skill(join(config, "skills", directory), name, desc);
    skill(join(config, "skills", "a".repeat(64)), "a".repeat(64), "x".repeat(1024));
    const commands = paneCommands("opencode", null, home);
    expect(commands.filter((row) => row.source === "skill").map((row) => row.name)).toEqual(["a".repeat(64), "customize-opencode"]);
  });

  it("lists a v1 skill that has only a string name, with an empty description", () => {
    const { home, config } = fixture();
    put(join(config, "skills", "bare", "SKILL.md"), "---\nname: bare\n---\nBody\n");
    put(join(config, "skills", "blank", "SKILL.md"), "---\nname: blank\ndescription: \"  \"\n---\nBody\n");
    const commands = paneCommands("opencode", null, home);
    expect(commands.filter((row) => row.source === "skill" && row.origin === "user").map(({ name, description }) => [name, description])).toEqual([["bare", ""], ["blank", ""]]);
  });

  it("merges JSONC and markdown commands and lets commands win over skills", () => {
    const { home, repo, cwd, config } = fixture();
    put(join(config, "opencode.json"), JSON.stringify({ command: { user: { template: "x", description: "User" }, collision: { template: "x" }, invalid: { description: "No template" } } }));
    put(join(repo, "opencode.jsonc"), `{
      // a URL and comment-like text inside a string remain intact
      "command": { "json-command": { "template": "https://example.com/*x*/,", "description": "JSON", }, },
    }`);
    put(join(repo, ".opencode", "commands", "collision.md"), "---\ndescription: Project command\n---\nBody");
    put(join(config, "commands", "markdown.md"), "---\ndescription: >-\n  First sentence.\n  More detail.\n---\nBody");
    put(join(config, "opencode.jsonc"), "malformed");
    for (const name of ["collision", "init"]) skill(join(config, "skills", name), name);
    const commands = paneCommands("opencode", cwd, home);
    expect(commands.filter((row) => row.source === "user" || row.source === "project").map(({ name, source }) => [name, source])).toEqual([
      ["collision", "project"], ["json-command", "project"], ["markdown", "user"], ["user", "user"],
    ]);
    expect(commands.filter((row) => row.name === "collision")).toHaveLength(1);
    expect(commands.find((row) => row.name === "markdown")?.description).toBe("First sentence. More detail.");
    expect(commands.find((row) => row.name === "init")?.source).toBe("builtin");
  });
});

const byName = <T extends { name: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.name.localeCompare(b.name));
const ctx = (root: ReturnType<typeof fixture>, version: string | null, environ: string[] = []): AgentCommandContext => ({
  home: root.home, cwd: root.cwd, repoRoot: root.repo, env: environ, roots: { environ }, version,
});

describe("OpenCode v1 catalog", () => {
  // Every primary slash name registered at v1.19.3 by a slashName or `slash: { name }` entry in packages/tui/src:
  // app.tsx, component/prompt/index.tsx, routes/session/index.tsx, feature-plugins/system/diff-viewer.tsx
  // (plugin/command-shim.ts and keymap.tsx only forward them); no other package registers one. init and
  // review come from packages/opencode/src/command/index.ts. Aliases stay unlisted: sessions (resume,
  // continue), new (clear), models (mo), org (orgs, switch-org), exit (quit, q), compact (summarize),
  // timestamps (toggle-timestamps), thinking (toggle-thinking). org and update register only under a
  // runtime condition, workspaces and warp only behind OPENCODE_EXPERIMENTAL_WORKSPACES; the scan sees none.
  const PINNED_V1_SLASH = [
    "sessions", "new", "workspaces", "models", "agents", "mcps", "variants", "connect", "org", "status", "update", "debug",
    "themes", "help", "exit", "editor", "skills", "warp", "move", "diff",
    "rename", "timeline", "fork", "compact", "undo", "redo", "timestamps", "thinking", "copy", "export",
    "init", "review",
  ];
  it("lists every command the pinned v1 TUI registers, once, in the terminal group where only the TUI can run it", () => {
    const { home } = fixture();
    const rows = paneCommands("opencode", null, home, {}, "1.19.3").filter((row) => row.source === "builtin");
    expect(PINNED_V1_SLASH.filter((name) => !rows.some((row) => row.name === name))).toEqual([]);
    expect(rows.map((row) => row.name).sort()).toEqual([...PINNED_V1_SLASH].sort());
    for (const name of ["rename", "timeline", "fork", "copy", "export", "thinking", "timestamps", "org", "warp", "workspaces"]) {
      expect(rows.find((row) => row.name === name)).toMatchObject({ visibility: "terminal", forms: [{ match: "bare", interaction: "terminal" }] });
    }
    expect(rows.every((row) => row.provenance?.verified === true)).toBe(true);
  });

  it("reads command/ and commands/ recursively with nested names, dot directories and symlinked files", () => {
    const r = fixture();
    put(join(r.repo, ".opencode", "commands", "team", "check.md"), "---\ndescription: Team check\n---\nRun");
    put(join(r.repo, ".opencode", "command", "legacy.md"), "---\ndescription: Legacy\n---\nRun");
    put(join(r.config, "commands", ".private", "note.md"), "---\ndescription: Note\n---\nRun");
    put(join(r.config, "commands", "deep", "er", "leaf.md"), "Leaf prompt");
    put(join(r.config, "commands", "README.txt"), "not a command");
    const rows = byName(source.discover(ctx(r, null)).filter((row) => row.source === "user" || row.source === "project"));
    expect(rows.map(({ name, source, description }) => [name, source, description])).toEqual([
      [".private/note", "user", "Note"], ["deep/er/leaf", "user", "Leaf prompt"],
      ["legacy", "project", "Legacy"], ["team/check", "project", "Team check"],
    ]);
  });

  it("selects the v1 shape for a missing, unreadable or 1.x version", () => {
    const r = fixture();
    skill(join(r.config, "skills", "plain"), "plain");
    for (const version of [null, undefined, "garbage", "1.19.3"]) {
      const rows = source.discover({ ...ctx(r, null), version });
      expect(rows.find((row) => row.name === "plain")?.trigger).toBeUndefined();
      expect(rows.some((row) => row.source === "builtin" && row.name === "move")).toBe(true);
      expect(rows.some((row) => row.source === "builtin" && row.name === "open")).toBe(false);
    }
  });

  it("honors XDG_CONFIG_HOME for the config directory", () => {
    const r = fixture();
    const xdg = join(r.root, "xdg");
    skill(join(xdg, "opencode", "skills", "from-xdg"), "from-xdg");
    skill(join(r.config, "skills", "from-home"), "from-home");
    const rows = source.discover(ctx(r, null, [`XDG_CONFIG_HOME=${xdg}`]));
    expect(rows.filter((row) => row.origin === "user").map((row) => row.name)).toEqual(["from-xdg"]);
  });

  it("offers the six former exclusions as terminal-bound and marks pickers terminal, undo and redo none", () => {
    expect([...(source.terminalBound ?? [])].sort()).toEqual(["agents", "connect", "editor", "sessions", "skills", "themes"]);
    for (const name of source.terminalBound ?? []) expect(source.builtins).toContain(name);
    for (const name of ["models", "variants", "mcps", "agents", "connect", "sessions", "themes", "skills", "editor", "status", "debug", "help", "diff"]) {
      expect(source.forms?.[name]).toEqual([{ match: "bare", interaction: "terminal" }]);
    }
    for (const name of ["undo", "redo"]) expect(source.forms?.[name]).toEqual([{ match: "bare", interaction: "none" }]);
    expect(source.pin).toEqual(["1.19.3", "2.0.32"]);
  });

  it("lists every former exclusion with visibility terminal and rows from a scan unverified", () => {
    const { home, config } = fixture();
    skill(join(config, "skills", "plain"), "plain");
    const rows = paneCommands("opencode", null, home);
    for (const name of ["agents", "connect", "editor", "sessions", "skills", "themes"]) {
      expect(rows.find((row) => row.name === name)?.visibility).toBe("terminal");
    }
    expect(rows.find((row) => row.name === "models")?.visibility).toBe("offered");
    expect(rows.find((row) => row.name === "plain")?.provenance).toEqual({ transport: "scan", verified: false });
  });
});

describe("OpenCode v2 catalog", () => {
  const V2 = "2.0.32";
  it("verifies the builtins both TUIs share on a v2 pane as on a v1 one", () => {
    const { home } = fixture();
    const verified = (version: string) => paneCommands("opencode", null, home, {}, version).find((row) => row.name === "models")?.provenance?.verified;
    expect(verified(V2)).toBeTrue();
    expect(verified("1.19.9")).toBeTrue();
    expect(verified("2.1.0")).toBeFalse();
    expect(verified("1.20.0")).toBeFalse();
  });

  it("gives skills the @ trigger and the id the path derives", () => {
    const r = fixture();
    put(join(r.config, "skills", "git-release", "SKILL.md"), "---\nname: Git Release\ndescription: Release\n---\nBody");
    put(join(r.config, "skills", "teams", "release", "SKILL.md"), "---\nname: Team Release\n---\nBody");
    put(join(r.config, "skills", "review.md"), "---\ndescription: Loose\n---\nBody");
    put(join(r.config, "skills", "nested", "ignored.md"), "---\ndescription: Not at the root\n---\nBody");
    put(join(r.repo, ".opencode", "skills", "SKILL.md"), "---\ndescription: Root file\n---\nBody");
    const rows = byName(source.discover(ctx(r, V2)).filter((row) => row.source === "skill" && row.origin !== "bundled"));
    expect(rows.map(({ name, description, trigger, origin }) => [name, description, trigger, origin])).toEqual([
      ["git-release", "Release", "@", "user"], ["release", "", "@", "user"], ["review", "Loose", "@", "user"],
      ["SKILL", "Root file", "@", "project"],
    ]);
  });

  it("does not validate v2 skill ids the way v1 does and lets the later source win", () => {
    const r = fixture();
    put(join(r.home, ".claude", "skills", "Mixed_Case", "SKILL.md"), "---\nname: other\ndescription: Claude\n---\n");
    put(join(r.home, ".agents", "skills", "dup", "SKILL.md"), "---\ndescription: agents\n---\n");
    put(join(r.config, "skills", "dup", "SKILL.md"), "---\ndescription: config\n---\n");
    const rows = byName(source.discover(ctx(r, V2)).filter((row) => row.source === "skill" && row.origin !== "bundled"));
    expect(rows.map((row) => [row.name, row.description])).toEqual([["dup", "config"], ["Mixed_Case", "Claude"]]);
  });

  it("reads plural commands plus the legacy singular directory and the commands JSON key", () => {
    const r = fixture();
    put(join(r.repo, ".opencode", "commands", "team", "review.md"), "---\ndescription: Team\n---\nBody");
    put(join(r.repo, ".opencode", "command", "old.md"), "---\ndescription: Old\n---\nBody");
    put(join(r.repo, "opencode.jsonc"), JSON.stringify({ commands: { audit: { template: "x", description: "Audit" } }, command: { v1only: { template: "x" } } }));
    const rows = source.discover(ctx(r, V2)).filter((row) => row.source === "project");
    expect(rows.map((row) => row.name).sort()).toEqual(["audit", "old", "team/review"]);
  });

  it("keeps a skill named like a command: @skills and /commands do not collide", () => {
    const r = fixture();
    put(join(r.repo, ".opencode", "commands", "audit.md"), "Body");
    skill(join(r.config, "skills", "audit"), "audit");
    const rows = source.discover(ctx(r, V2));
    expect(rows.filter((row) => row.name === "audit").map((row) => row.source).sort()).toEqual(["project", "skill"]);
  });

  it("lists v2 builtins through paneCommands with move gone and provenance verified at 2.0.x", () => {
    const { home } = fixture();
    const rows = paneCommands("opencode", null, home, {}, V2).filter((row) => row.source === "builtin");
    const names = rows.map((row) => row.name);
    expect(names).not.toContain("move");
    expect(names).toEqual(expect.arrayContaining(["open", "cd", "clear", "reload", "pair", "stats", "terminal", "highlights", "btw", "agents"]));
    expect(rows.find((row) => row.name === "open")?.provenance).toEqual({ transport: "static", verified: true });
    expect(paneCommands("opencode", null, home, {}, "1.19.3").find((row) => row.name === "move")?.provenance).toEqual({ transport: "static", verified: true });
    expect(paneCommands("opencode", null, home, {}, null).find((row) => row.name === "move")?.provenance).toEqual({ transport: "static", verified: false });
    expect(paneCommands("opencode", null, home, {}, null).find((row) => row.name === "open")).toBeUndefined();
  });

  // Every primary slash name registered at 843a6c51 by a `slash: { name }` entry in packages/tui/src:
  // app.tsx, component/prompt/index.tsx, component/session-frame.tsx, routes/session/index.tsx,
  // feature-plugins/prompt/btw.tsx, feature-plugins/system/{diff-viewer,plugins,stats}.tsx.
  // (test/fixture/plugin/setup-keymap registers setup-check for a test and is no command.) No other
  // package registers one. Aliases stay unlisted: sessions (resume, continue), open (projects, project),
  // variants (thinking, effort), pair (web), exit (quit, q). update, restart and redo register only
  // under a runtime condition the scan cannot see.
  const PINNED_V2_SLASH = [
    "sessions", "new", "clear", "open", "models", "agents", "mcps", "variants", "connect", "highlights", "settings", "status",
    "update", "pair", "restart", "reload", "debug", "themes", "help", "exit",
    "cd", "editor", "skills", "worktrees", "terminal", "btw", "diff", "plugins", "stats",
    "rename", "timeline", "fork", "compact", "undo", "redo", "copy", "export",
  ];
  it("lists every command the pinned v2 TUI registers", () => {
    const names = new Set(source.discover(ctx(fixture(), V2)).filter((row) => row.source === "builtin").map((row) => row.name));
    for (const name of source.builtins) names.add(name);
    expect(PINNED_V2_SLASH.filter((name) => !names.has(name))).toEqual([]);
    const paneNames = paneCommands("opencode", null, fixture().home, {}, V2).map((row) => row.name);
    expect(PINNED_V2_SLASH.filter((name) => !paneNames.includes(name))).toEqual([]);
    expect(paneCommands("opencode", null, fixture().home, {}, V2).find((row) => row.name === "settings")?.forms).toEqual([{ match: "bare", interaction: "terminal" }]);
  });

  it("emits the v2-only builtins with their forms and no v1-only ones", () => {
    const rows = source.discover(ctx(fixture(), V2)).filter((row) => row.source === "builtin");
    expect(rows.map((row) => row.name).sort()).toEqual(["btw", "cd", "clear", "compact", "copy", "export", "fork", "highlights", "open", "pair", "plugins", "reload", "rename", "restart", "settings", "stats", "terminal", "timeline", "update", "worktrees"]);
    expect(rows.find((row) => row.name === "btw")?.forms).toEqual([{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }]);
    expect(rows.every((row) => row.provenance?.transport === "static" && row.provenance.verified)).toBe(true);
    expect(source.discover(ctx(fixture(), "2.1.0")).filter((row) => row.source === "builtin").every((row) => row.provenance?.verified === false)).toBe(true);
  });
});

describe("OpenCode skill identity", () => {
  it("lists a skill reached through a symlinked alias root once, identified by its real file, in v1 and v2", () => {
    const { home, config } = fixture();
    skill(join(config, "skills", "aliased"), "aliased");
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(join(config, "skills"), join(home, ".agents", "skills"), "dir");
    for (const version of [null, "2.0.32"]) {
      const rows = paneCommands("opencode", null, home, {}, version).filter((row) => row.name === "aliased");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "skill", id: realpathSync(join(config, "skills", "aliased", "SKILL.md")) });
    }
  });
});
