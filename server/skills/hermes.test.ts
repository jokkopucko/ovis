import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./hermes.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hermes-menu-"));
  temporary.push(root);
  const home = join(root, "home");
  const profile = join(home, "profile");
  const repo = join(home, "repo");
  const cwd = join(repo, "src", "nested");
  mkdirSync(cwd, { recursive: true });
  put(join(repo, ".git"), "gitdir: /unused/worktree\n");
  const config = (skills: Record<string, unknown> = {}, quick_commands: Record<string, unknown> = {}) =>
    put(join(profile, "config.yaml"), Bun.YAML.stringify({ skills, quick_commands }));
  const skill = (root: string, directory: string, fields: Record<string, unknown> = {}, body = "Probe body.") =>
    put(join(root, directory, "SKILL.md"), `---\n${Bun.YAML.stringify(fields)}\n---\n${body}\n`);
  const commands = (extra: string[] = []) => paneCommands("hermes", cwd, home, { environ: [`HERMES_HOME=${profile}`, ...extra] });
  const discovered = () => commands().filter((command) => command.source !== "builtin");
  return { root, home, profile, repo, cwd, config, skill, commands, discovered };
}

describe("Hermes commands", () => {
  it("bounds fallback body reads to the first 64 KiB", () => {
    const f = fixture();
    const path = join(f.profile, "skills", "huge", "SKILL.md");
    put(path, `---\nname: huge\n---\n${"\n".repeat(64 * 1024)}outside-prefix\n`);
    const rows = f.discovered();
    const row = rows.find(({ name }) => name === "huge");
    expect(row).toBeDefined();
    expect(row?.description).not.toBe("outside-prefix");
  });

  it("does not parse a vertical-whitespace delimiter as frontmatter", () => {
    const f = fixture();
    const body = "Body after the malformed header";
    put(join(f.profile, "skills", "malformed", "SKILL.md"), `---\v\nname: malformed\n---\n${body}\n`);
    const rows = f.discovered();
    const row = rows.find(({ name }) => name === "malformed");
    expect(row).toBeDefined();
    expect(row?.description).not.toBe(body);
  });

  it("keeps CLI CommandDefs and palette aliases, including terminal-bound screens", () => {
    const f = fixture();
    const rows = f.commands();
    const names = new Set(rows.map((command) => command.name));
    expect(rows.every((command) => command.source === "builtin")).toBeTrue();
    for (const name of ["new", "status", "clear", "reset", "prompt", "compose", "voice", "login", "tasks", "reload_skills"]) expect(names.has(name)).toBeTrue();
    for (const name of ["start", "topic", "pause", "approve", "deny", "sethome", "set-home", "commands", "restart", "platform"]) expect(names.has(name)).toBeFalse();
    for (const name of ["model", "resume", "sessions", "config", "agents", "plugins", "skills", "skin"]) expect(names.has(name)).toBeTrue();
    for (const [name, dialog] of [["help", "hermes-help"], ["status", "hermes-status"], ["version", "hermes-version"], ["v", "hermes-version"],
      ["profile", "hermes-profile"], ["reload-skills", "hermes-reload-skills"], ["reload_skills", "hermes-reload-skills"]]) {
      expect(source.forms?.[name!]).toEqual([{ match: "bare", interaction: "dialog", dialog }]);
    }
    expect(rows.find((command) => command.name === "reset")?.description).toBe(rows.find((command) => command.name === "new")?.description);
  });

  it("honors HERMES_HOME and separates local, bundled and trusted project skills", () => {
    const f = fixture();
    f.config({ trusted_project_dirs: [f.repo] });
    f.skill(join(f.home, ".hermes", "skills"), "wrong-home");
    f.skill(join(f.profile, "skills"), "category/my_skill", { description: "Personal." });
    f.skill(join(f.profile, "skills"), "category/stock", { name: "Stock Skill", description: "Installed stock." });
    f.skill(join(f.home, ".hermes", "hermes-agent", "skills"), "other/stock", { name: "Stock Skill" });
    f.skill(join(f.repo, ".hermes", "skills"), "project", { description: "Project." });
    f.skill(join(f.repo, ".agents", "skills"), "agent-project");
    f.skill(join(f.cwd, ".hermes", "skills"), "not-root");
    expect(f.discovered()).toMatchObject([
      { name: "agent-project", description: "Probe body.", source: "skill", origin: "project" },
      { name: "my-skill", description: "Personal.", source: "skill", origin: "user" },
      { name: "project", description: "Project.", source: "skill", origin: "project" },
      { name: "stock-skill", description: "Installed stock.", source: "skill", origin: "bundled" },
    ]);
  });

  it("reads Windows Hermes skills under LOCALAPPDATA, where 0.21.5 keeps its home and checkout", () => {
    const f = fixture();
    const hermes = join(f.root, "local", "hermes");
    f.skill(join(hermes, "skills"), "stock", { name: "Stock Skill", description: "Installed stock." });
    f.skill(join(hermes, "skills"), "mine", { description: "Personal." });
    f.skill(join(hermes, "hermes-agent", "skills"), "other/stock", { name: "Stock Skill" });
    f.skill(join(f.home, ".hermes", "skills"), "wrong-home");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(paneCommands("hermes", f.cwd, f.home, { environ: [`LOCALAPPDATA=${join(f.root, "local")}`] }).filter((command) => command.source === "skill")).toMatchObject([
        { name: "mine", description: "Personal.", origin: "user" },
        { name: "stock-skill", description: "Installed stock.", origin: "bundled" },
      ]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("finds Windows Hermes under the server's LOCALAPPDATA when the pane's environment cannot be read, and a read one wins", () => {
    const f = fixture();
    const redirected = join(f.root, "redirected");
    f.skill(join(redirected, "hermes", "skills"), "redirected", { description: "Redirected store." });
    f.skill(join(f.root, "pane", "hermes", "skills"), "pane-local", { description: "Pane store." });
    f.skill(join(f.home, "AppData", "Local", "hermes", "skills"), "profile-default");
    f.skill(join(f.profile, "skills"), "server-profile");
    const skills = (environ: string[] | null, server: Record<string, string>) =>
      paneCommands("hermes", f.cwd, f.home, { environ }, null, server).filter((command) => command.source === "skill").map((command) => command.name);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(skills(null, { LOCALAPPDATA: redirected })).toEqual(["redirected"]);
      expect(skills(null, { LocalAppData: redirected })).toEqual(["redirected"]);
      expect(skills(null, { LOCALAPPDATA: redirected, HERMES_HOME: f.profile })).toEqual(["redirected"]);
      expect(skills([`LOCALAPPDATA=${join(f.root, "pane")}`], { LOCALAPPDATA: redirected, HERMES_HOME: f.profile })).toEqual(["pane-local"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("never offers untrusted projects, disabled discovery, non-repositories or a home repository", () => {
    const f = fixture();
    f.skill(join(f.repo, ".hermes", "skills"), "private-project");
    f.config();
    expect(f.discovered()).toEqual([]);
    f.config({ trusted_project_dirs: [f.repo], project_discovery: false });
    expect(f.discovered()).toEqual([]);
    f.config({ trusted_project_dirs: [f.cwd] });
    expect(f.discovered()).toEqual([]);
    put(join(f.home, ".git"), "");
    f.skill(join(f.home, ".agents", "skills"), "home-project");
    f.config({ trusted_project_dirs: [f.home] });
    expect(paneCommands("hermes", f.home, f.home, { environ: [`HERMES_HOME=${f.profile}`] }).filter((command) => command.source === "skill")).toEqual([]);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    f.skill(join(outside, ".hermes", "skills"), "not-a-repo");
    f.config({ trusted_project_dirs: [outside] });
    expect(paneCommands("hermes", outside, f.home, { environ: [`HERMES_HOME=${f.profile}`] }).filter((command) => command.source === "skill")).toEqual([]);
  });

  it("expands create and external roots, dedupes roots and applies tier precedence", () => {
    const f = fixture();
    f.config({ trusted_project_dirs: [f.repo], create_dir: "created", external_dirs: ["${EXTRA}", "~/shared", "skills", "created"] });
    const local = join(f.profile, "skills");
    const created = join(f.profile, "created");
    const external = join(f.profile, "external");
    for (const root of [join(f.repo, ".hermes", "skills"), local, created, external]) f.skill(root, "winner", { description: root });
    for (const root of [local, created, external]) f.skill(root, "local-wins", { description: root });
    for (const root of [created, external]) f.skill(root, "create-wins", { description: root });
    f.skill(external, "external-only");
    f.skill(join(f.home, "shared"), "tilde-only");
    const rows = f.commands(["EXTRA=external"]).filter((command) => command.source === "skill");
    expect(rows.map((command) => command.name)).toEqual(["create-wins", "external-only", "local-wins", "tilde-only", "winner"]);
    expect(rows.find((command) => command.name === "winner")).toMatchObject({ description: join(f.repo, ".hermes", "skills"), origin: "project" });
    expect(rows.find((command) => command.name === "local-wins")?.description).toBe(local);
    expect(rows.find((command) => command.name === "create-wins")?.description).toBe(created);
  });

  it("normalizes names, filters disabled and core collisions, and retains full descriptions", () => {
    const f = fixture();
    f.config({ disabled: '["off", "hermes-agent"]' });
    const root = join(f.profile, "skills");
    for (const name of ["off", "hermes-agent", "new", "reset", "model", "start", "set-home"]) f.skill(root, name);
    f.skill(root, "normal", { name: "Foo__ Bar++", description: "x".repeat(220) });
    f.skill(root, "unicode", { name: "文書" });
    f.skill(root, "invalid", { name: "+++" });
    f.skill(root, "no-header", {}, "# Heading\n\nA body description.\nSecond line.");
    f.skill(root, "no-body", {}, "# Heading");
    f.skill(root, "wrong-platform", { platforms: ["not-an-os"] });
    expect(f.discovered().map((command) => command.name)).toEqual(["foo-bar", "hermes-agent", "no-body", "no-header", "文書"]);
    expect(f.discovered().find((command) => command.name === "foo-bar")?.description).toHaveLength(220);
    expect(f.discovered().find((command) => command.name === "no-header")?.description).toBe("A body description.");
    expect(f.discovered().find((command) => command.name === "no-body")?.description).toBe("Invoke the no-body skill");
  });

  it("omits same-tier ambiguous names and keeps identical shallow copies and first slug wins", () => {
    const f = fixture();
    f.config();
    const root = join(f.profile, "skills");
    f.skill(root, "a/one", { name: "ambiguous" }, "One.");
    f.skill(root, "b/two", { name: "ambiguous" }, "Two.");
    f.skill(root, "shallow", { name: "same", description: "Identical." });
    f.skill(root, "category/deep", { name: "same", description: "Identical." });
    f.skill(root, "a/slug", { name: "git_helper", description: "First." });
    f.skill(root, "b/slug", { name: "git-helper", description: "Second." });
    symlinkSync(root, join(root, "cycle"), "dir");
    f.skill(root, "scripts/support", { name: "root-support" });
    f.skill(root, "parent", { name: "parent" });
    f.skill(root, "parent/scripts/support", { name: "support" });
    f.skill(root, "parent/child", { name: "child" });
    put(join(root, "loose.md"), "Not a skill.");
    expect(f.discovered()).toMatchObject([
      { name: "child", description: "Probe body.", source: "skill", origin: "user" },
      { name: "git-helper", description: "First.", source: "skill", origin: "user" },
      { name: "parent", description: "Probe body.", source: "skill", origin: "user" },
      { name: "root-support", description: "Probe body.", source: "skill", origin: "user" },
      { name: "same", description: "Identical.", source: "skill", origin: "user" },
    ]);
  });

  it("loads YAML bundles and quick commands in dispatch precedence without duplicate rows", () => {
    const f = fixture();
    f.config({}, {
      fastcheck: { type: "exec", command: "git status", description: "Quick check." },
      release: { type: "alias", command: "/status", description: "Quick release." },
      new: { type: "alias", command: "/status" },
    });
    const root = join(f.profile, "skills");
    f.skill(root, "release");
    f.skill(root, "bundle-only");
    put(join(f.profile, "skill-bundles", "a.yaml"), Bun.YAML.stringify({ name: "release", skills: ["release"] }));
    put(join(f.profile, "skill-bundles", "b.yml"), Bun.YAML.stringify({ name: "bundle_only", skills: ["release", "bundle-only"], description: "Bundle description." }));
    put(join(f.profile, "skill-bundles", "c.yml"), Bun.YAML.stringify({ name: "bundle_only", skills: ["other"], description: "Duplicate." }));
    put(join(f.profile, "skill-bundles", "fallback.yml"), "skills: [release]\n");
    put(join(f.profile, "skill-bundles", "bad.yaml"), "skills: [\n");
    put(join(f.profile, "skill-bundles", "empty.yaml"), "skills: []\n");
    put(join(f.profile, "skill-bundles", "scalar.yaml"), "skills: release\n");
    expect(f.discovered()).toMatchObject([
      { name: "bundle-only", description: "Bundle description.", source: "skill", origin: "user" },
      { name: "fallback", description: "Load 1 skills as a bundle", source: "skill", origin: "user" },
      { name: "fastcheck", description: "Quick check.", source: "user" },
      { name: "release", description: "Quick release.", source: "user" },
    ]);
  });

  it("uses default home and malformed configuration without scanning plugin or global agent skills", () => {
    const f = fixture();
    const root = join(f.home, ".hermes", "skills");
    f.skill(root, "probe-skill");
    f.skill(join(f.home, ".agents", "skills"), "not-external");
    f.skill(join(f.home, ".hermes", "plugins", "enabled", "skills"), "plugin");
    put(join(f.home, ".hermes", "config.yaml"), "skills: [\n");
    expect(paneCommands("hermes", f.cwd, f.home).filter((command) => command.source === "skill")).toMatchObject([
      { name: "probe-skill", description: "Probe body.", source: "skill", origin: "user" },
    ]);
  });

  it("declares formerly terminal-bound builtins and the screens that wait for a key in the scanner source", () => {
    expect(source.terminalBound).toEqual(["model", "resume", "sessions", "config", "agents", "plugins", "skills", "skin",
      "reload-mcp", "reload_mcp", "update", "undo", "prompt", "compose", "palette", "tasks", "journey", "learning", "memory-graph",
      "subscription", "upgrade", "topup", "login", "debug"]);
  });

  it("keeps new, reset and clear in the terminal unless they are told to skip the confirmation", () => {
    const rows = fixture().commands();
    for (const name of ["new", "reset", "clear"]) {
      expect(rows.find((command) => command.name === name)?.forms).toEqual([
        { match: "bare", interaction: "terminal" },
        { match: { sub: "now" }, interaction: "none" }, { match: { sub: "--yes" }, interaction: "none" }, { match: { sub: "-y" }, interaction: "none" },
        { match: "other", interaction: "terminal" },
      ]);
    }
    expect(source.forms?.curator).toContainEqual({ match: { sub: "purge" }, interaction: "terminal" });
    expect(source.forms?.curator?.[0]).toEqual({ match: "bare", interaction: "unknown" });
  });

  it("emits former screen commands as terminal-visible catalog rows", () => {
    const f = fixture();
    for (const name of source.terminalBound ?? []) {
      expect(f.commands().find((command) => command.name === name)).toMatchObject({
        visibility: "terminal",
        provenance: { transport: "static", verified: false },
      });
    }
  });

  it("compiles Hermes status to its result reader's bare dialog form", () => {
    const f = fixture();
    expect(f.commands().find((command) => command.name === "status")).toMatchObject({
      forms: [{ match: "bare", interaction: "dialog", dialog: "hermes-status" }],
    });
  });
});

describe("Hermes skill identity", () => {
  it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const f = fixture();
    const alias = join(f.root, "alias");
    f.skill(join(f.profile, "skills"), "aliased", { description: "Aliased." });
    symlinkSync(join(f.profile, "skills"), alias, "dir");
    f.config({ external_dirs: [alias] });
    const rows = f.discovered().filter((command) => command.name === "aliased");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", id: realpathSync(join(f.profile, "skills", "aliased", "SKILL.md")) });
  });

  it("offers no command for one file reached through two roots of the same tier, as Hermes leaves it ambiguous", () => {
    // Hermes 354724fb: os.walk(followlinks=True) finds the file under both roots (agent/skill_utils.py:842-851);
    // pick_skill_candidate settles same-tier contenders only inside one root (agent/skill_utils.py:431-442),
    // so the entry is "ambiguous" and scan_skill_commands registers only "unique" ones (agent/skill_commands.py:497-500)
    const f = fixture();
    const first = join(f.root, "first"), second = join(f.root, "second");
    f.skill(first, "aliased", { description: "Aliased." });
    mkdirSync(second, { recursive: true });
    symlinkSync(join(first, "aliased"), join(second, "aliased"), "dir");
    f.config({ external_dirs: [first] });
    expect(f.discovered().filter((command) => command.name === "aliased")).toHaveLength(1);
    f.config({ external_dirs: [first, second] });
    expect(f.discovered().filter((command) => command.name === "aliased")).toHaveLength(0);
  });
});
