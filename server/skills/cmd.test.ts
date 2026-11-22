import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { typedTerminalCommand } from "../../src/lib/compose.ts";
import { source } from "./cmd.ts";
import { createWalkBudget } from "./walk.ts";

// Copied from Command Code 1.84.0, dist/bundled/command-code-knowledge/reference/custom-slash-commands.md:
// `/clear` (`/new`): Start a new session with empty context; previous stays on disk, resumable with `/resume`
// `/resume` (`/sessions`): Resume a past conversation
// `/exit` (`/quit`): Exit Command Code
// `/feedback [title]` (alias `/issue`): Report a bug or share feedback; opens a prefilled GitHub issue
// Copied from product-help.md: `/learn (courses): Open the Command Code learn hub in your browser`
const PINNED_SLASH_COMMANDS = [
  "init", "import", "goal", "memory", "resume", "fork", "worktree", "clone", "rename", "name", "rewind",
  "tree", "clear", "theme", "language", "share", "unshare", "taste", "learn-taste", "skills", "agents",
  "design", "mcp", "model", "effort", "connect", "compact", "compact-mode", "config", "context", "ide",
  "terminal-setup", "login", "logout", "learn", "feedback", "trace", "session-file", "copy", "export",
  "changelog", "hotkeys", "todos", "loop", "rc", "plan", "mode", "mode:default", "mode:accept-edits",
  "mode:plan", "plans", "plan-review", "review", "pr-comments", "add-dir", "status", "statusline", "usage",
  "upgrade", "extra", "update", "reload", "mods", "help", "exit",
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "cmd-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function skill(root: string, name: string, description = `${name} skill`): string {
  const path = join(root, name, "SKILL.md");
  put(path, `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
  return path;
}
function context(home: string, cwd: string | null = null) {
  return { home, cwd, repoRoot: null, env: null, roots: {} };
}

describe("Command Code command catalog", () => {
  for (const [location, depth, count] of [
    ["personal", 0, 600],
    ["project", 0, 600],
    ["project", 3, 300],
    ["agents", 5, 100],
  ] as const) {
    it(`lists all ${count} ordinary ${location} skills with cwd ${depth} levels deep`, () => {
      const home = temp();
      const repo = temp();
      const cwd = join(repo, ...Array.from({ length: depth }, (_, i) => `level-${i}`));
      mkdirSync(cwd, { recursive: true });
      put(join(repo, ".git"), "");
      const directory = location === "personal" ? join(home, ".commandcode", "skills")
        : join(repo, location === "agents" ? ".agents" : ".commandcode", "skills");
      const expected = Array.from({ length: count }, (_, i) => realpathSync(skill(directory, `ordinary-${i}`))).sort();
      const rows = source.discover(context(home, cwd)).filter(({ name }) => name.startsWith("ordinary-"));
      expect(rows.map(({ id }) => id).sort()).toEqual(expected);
    });
  }

  it("lists ordinary skills when 1022 configured roots do not exist", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const expected = Array.from({ length: 100 }, (_, i) => realpathSync(skill(join(repo, "existing"), `ordinary-${i}`))).sort();
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({
      skills: [...Array.from({ length: 1022 }, (_, i) => `./missing-${i}`), "./existing"],
    }));
    const rows = source.discover(context(home, repo)).filter(({ name }) => name.startsWith("ordinary-"));
    expect(rows.map(({ id }) => id).sort()).toEqual(expected);
  });

  it("reuses later leftovers for an unfinished ordinary root", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const expected = [
      ...Array.from({ length: 3000 }, (_, i) => realpathSync(skill(join(home, ".commandcode", "skills"), `ordinary-personal-${i}`))),
      ...Array.from({ length: 900 }, (_, i) => realpathSync(skill(join(repo, ".agents", "skills"), `ordinary-project-${i}`))),
    ].sort();
    const rows = source.discover(context(home, repo)).filter(({ name }) => name.startsWith("ordinary-"));
    expect(rows.map(({ id }) => id).sort()).toEqual(expected);
  });

  it("lists all 600 ordinary commands below missing ancestor roots", () => {
    const home = temp();
    const repo = temp();
    const cwd = join(repo, "one", "two", "three", "four", "five");
    mkdirSync(cwd, { recursive: true });
    put(join(repo, ".git"), "");
    const expected = Array.from({ length: 600 }, (_, i) => {
      const path = join(home, ".commandcode", "commands", `ordinary-${i}.md`);
      put(path, "Command");
      return realpathSync(path);
    }).sort();
    const rows = source.discover(context(home, cwd)).filter(({ name }) => name.startsWith("ordinary-"));
    expect(rows.map(({ id }) => id).sort()).toEqual(expected);
  });

  it("keeps project skills ahead of user and configured collisions", () => {
    // Command Code 1.84.0 createSkillRegistry and reference/skills.md:198-209.
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const winner = skill(join(repo, ".commandcode", "skills"), "collision");
    skill(join(repo, ".agents", "skills"), "collision");
    skill(join(home, ".commandcode", "skills"), "collision");
    skill(join(home, ".agents", "skills"), "collision");
    skill(join(repo, "extra"), "collision");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./extra"] }));
    const rows = source.discover(context(home, repo)).filter(({ name }) => name === "collision");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(realpathSync(winner));
  });

  it("walks command ancestors through the repository boundary", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    const cwd = join(repo, "src", "nested");
    mkdirSync(cwd, { recursive: true });
    put(join(repo, ".git"), "");
    for (const [directory, name] of [[cwd, "near"], [join(repo, "src"), "middle"], [repo, "root"], [join(repo, ".."), "outside"]] as const) {
      put(join(directory, ".commandcode", "commands", `${name}.md`), name);
    }
    const names = source.discover(context(home, cwd)).map(({ name }) => name);
    for (const name of ["near", "middle", "root"]) expect(names).toContain(name);
    expect(names).not.toContain("outside");
  });

  for (const withUser of [false, true]) {
    it(`keeps one deploy row using ${withUser ? "user" : "cwd"} command precedence`, () => {
      const home = temp();
      const repo = temp();
      const cwd = join(repo, "src");
      put(join(repo, ".git"), "");
      put(join(repo, ".commandcode", "commands", "deploy.md"), "Root");
      const local = join(cwd, ".commandcode", "commands", "deploy.md");
      put(local, "Cwd");
      const user = join(home, ".commandcode", "commands", "deploy.md");
      if (withUser) put(user, "User");
      const rows = source.discover(context(home, cwd)).filter(({ name }) => name === "deploy");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(realpathSync(withUser ? user : local));
    });
  }

  for (const order of [["z", "a"], ["a", "z"]] as const) {
    it(`keeps the first Node-ordered nested component in ${order.join("-")} creation order`, () => {
      // Node fs/promises.readdir sorts UTF-8 bytes; the loader walks depth-first.
      const home = temp();
      const root = join(home, ".commandcode", "commands");
      for (const directory of order) put(join(root, directory, "component.md"), directory);
      const rows = source.discover(context(home)).filter(({ name }) => name === "component");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(realpathSync(join(root, "a", "component.md")));
      expect(rows[0]?.description).toBe("a · a");
    });
  }

  for (const order of [["\uFF3A", "\u{1F600}"], ["\u{1F600}", "\uFF3A"]] as const) {
    it(`keeps the Node UTF-8 nested component in ${order.map((name) => name.codePointAt(0)?.toString(16)).join("-")} creation order`, () => {
      const home = temp();
      const root = join(home, ".commandcode", "commands");
      for (const directory of order) put(join(root, directory, "component.md"), directory);
      const rows = source.discover(context(home)).filter(({ name }) => name === "component");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(realpathSync(join(root, "\uFF3A", "component.md")));
      expect(rows[0]?.description).toBe("\uFF3A · \uFF3A");
    });
  }

  it("keeps the model builtin instead of a same-name custom command", () => {
    const home = temp();
    put(join(home, ".commandcode", "commands", "model.md"), "Custom");
    const rows = paneCommands("cmd", null, home).filter(({ name }) => name === "model");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("builtin");
  });

  it("finds user skills and every configured folder when the first root is huge", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const folders = Array.from({ length: 10 }, (_, i) => join(repo, `extra-${i}`));
    for (let i = 0; i < 4097; i++) {
      put(join(repo, "extra-0", `${i}.md`), "---\nname: huge\ndescription: Huge\n---\n");
    }
    for (const [i, folder] of folders.entries()) skill(folder, `configured-${i}`);
    skill(join(home, ".commandcode", "skills"), "personal");
    skill(join(repo, ".commandcode", "skills"), "project");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: folders }));
    const names = source.discover(context(home, repo)).map(({ name }) => name);
    expect(names).toContain("personal");
    expect(names).toContain("project");
    expect(names).toContain("huge");
    for (let i = 1; i < 10; i++) expect(names).toContain(`configured-${i}`);
  });

  it("retains a personal catalog whose complete work fits inside every reserved half", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const personal = join(home, ".commandcode", "skills");
    for (let i = 0; i < 100; i++) put(join(personal, `personal-${i}.md`), `---\nname: personal-${i}\ndescription: Personal\n---\n`);
    for (let i = 0; i < 16284; i++) put(join(personal, `asset-${i}.dat`), "");
    const shared = join(repo, "shared");
    for (let i = 0; i < 32; i++) put(join(shared, `hostile-${i}.md`), `---\nname: hostile-${i}\ndescription: Hostile\n---\n`);
    const aliases = Array.from({ length: 512 }, (_, i) => `alias-${i}`);
    for (const alias of aliases) symlinkSync(shared, join(repo, alias), "dir");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: aliases }));
    const reads = spyOn(fs, "readdirSync");
    try {
      const rows = source.discover(context(home, repo));
      const dirents = reads.mock.results.reduce((count, result) => count + (result.type === "return" ? result.value.length : 0), 0);
      expect(dirents).toBe(createWalkBudget().entries);
      expect(rows.filter(({ name }) => name.startsWith("personal-"))).toHaveLength(100);
    } finally { reads.mockRestore(); }
  }, 15000);

  it("keeps the catalog when a project command root is a plain file", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    put(join(repo, ".commandcode", "commands"), "Not a directory");
    put(join(home, ".commandcode", "commands", "user-command.md"), "User command");
    skill(join(home, ".commandcode", "skills"), "personal");
    const names = paneCommands("cmd", repo, home).map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining(["help", "personal", "user-command"]));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps the catalog when a project command root cannot be read", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const locked = join(repo, ".commandcode", "commands");
    put(join(locked, "hidden.md"), "Hidden command");
    put(join(home, ".commandcode", "commands", "user-command.md"), "User command");
    skill(join(home, ".commandcode", "skills"), "personal");
    chmodSync(locked, 0o000);
    try {
      const names = paneCommands("cmd", repo, home).map(({ name }) => name);
      expect(names).toEqual(expect.arrayContaining(["help", "personal", "user-command"]));
      expect(names).not.toContain("hidden");
    } finally { chmodSync(locked, 0o755); }
  });

  it("lists no row for a name a command root cut short by the bound may hold", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const userCommands = join(home, ".commandcode", "commands");
    for (let i = 0; i < createWalkBudget().reads; i++) put(join(userCommands, `a-${String(i).padStart(4, "0")}.md`), `User ${i}`);
    put(join(userCommands, "zdeploy.md"), "User deploy");
    put(join(repo, ".commandcode", "commands", "zdeploy.md"), "Project deploy");
    skill(join(home, ".commandcode", "skills"), "personal");
    const rows = paneCommands("cmd", repo, home);
    const names = rows.map(({ name }) => name);
    expect(rows.filter(({ description }) => description === "Project deploy")).toEqual([]);
    expect(names).not.toContain("zdeploy");
    // a skill's plain name could be an unlisted command's, so it is offered as /skill:<name>, which always runs the skill
    expect(names).toContain("skill:personal");
    expect(names).not.toContain("personal");
    expect(names).toContain("help");
  }, 15000);

  it("lists no row a cut-short command root found after the folder it skipped", () => {
    const home = temp();
    const userCommands = join(home, ".commandcode", "commands");
    // The folder bound runs out inside a-empty, so the walk skips b-skipped, whose deploy.md Command Code
    // reaches first (depth-first, byte order), and then still reads the root's own deploy.md.
    for (let i = 0; i < createWalkBudget().folders; i++) mkdirSync(join(userCommands, "a-empty", String(i).padStart(4, "0")), { recursive: true });
    put(join(userCommands, "b-skipped", "deploy.md"), "Skipped deploy");
    put(join(userCommands, "deploy.md"), "Root deploy");
    const rows = paneCommands("cmd", null, home);
    expect(rows.filter(({ description }) => /(Root|Skipped) deploy$/.test(description))).toEqual([]);
  }, 15000);

  it("reserves personal skills even when project settings list thousands of roots", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const personal = Array.from({ length: 600 }, (_, i) => `personal-${i}`);
    for (const name of personal) skill(join(home, ".commandcode", "skills"), name);
    const hostile = join(repo, "hostile");
    for (let i = 0; i < 64; i++) put(join(hostile, `file-${i}`), "");
    for (let i = 0; i < 4200; i++) symlinkSync(hostile, join(repo, String(i)), "dir");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: Array.from({ length: 4200 }, (_, i) => `./${i}`) }));
    const names = source.discover(context(home, repo)).map(({ name }) => name);
    expect(names.filter((name) => name.startsWith("personal-")).sort()).toEqual(personal.sort());
  });

  it("bounds readdir calls and dirents across 1000 existing configured aliases", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const shared = join(repo, "shared");
    const size = 4096;
    for (let i = 0; i < size; i++) put(join(shared, `file-${i}`), "");
    const configured = Array.from({ length: 1000 }, (_, i) => `alias-${i}`);
    for (const name of configured) symlinkSync(shared, join(repo, name), "dir");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: configured }));
    const reads = spyOn(fs, "readdirSync");
    try {
      source.discover(context(home, repo));
      const dirents = reads.mock.results.reduce((count, result) => count + (result.type === "return" ? result.value.length : 0), 0);
      expect(reads.mock.calls.length).toBeGreaterThan(0);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(createWalkBudget().entries / size);
      expect(dirents).toBeLessThanOrEqual(createWalkBudget().entries);
    } finally { reads.mockRestore(); }
  });

  it("charges missing configured root probes against the folder bound", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const configured = Array.from({ length: 6000 }, (_, i) => String(i));
    const paths = new Set(configured.map((name) => join(repo, name)));
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: configured }));
    const exists = spyOn(fs, "existsSync");
    const canonical = spyOn(fs, "realpathSync");
    try {
      source.discover(context(home, repo));
      const probes = [...exists.mock.calls, ...canonical.mock.calls].filter(([path]) => paths.has(String(path)));
      expect(probes.length).toBeGreaterThan(0);
      expect(probes.length).toBeLessThanOrEqual(createWalkBudget().folders);
    } finally { exists.mockRestore(); canonical.mockRestore(); }
  });

  it("shares one work bound across distinct configured folders", () => {
    const home = temp();
    const folders = [join(home, "extra-a"), join(home, "extra-b")];
    for (const folder of folders) {
      for (let i = 0; i < 2200; i++) put(join(folder, `${i}.md`), `---\nname: skill-${i}\ndescription: Present\n---\n`);
    }
    put(join(home, ".commandcode", "settings.json"), JSON.stringify({ skills: folders }));
    const opens = spyOn(fs, "openSync");
    try {
      source.discover(context(home));
      const skillReads = opens.mock.calls.filter(([path]) => folders.some((folder) => String(path).startsWith(folder + "/")));
      expect(skillReads.some(([path]) => String(path).startsWith(folders[0] + "/"))).toBeTrue();
      expect(skillReads.some(([path]) => String(path).startsWith(folders[1] + "/"))).toBeTrue();
      expect(skillReads.length).toBeLessThanOrEqual(createWalkBudget().reads);
    } finally { opens.mockRestore(); }
  });

  it("protects personal and configured skills from a huge project command root", () => {
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    for (let i = 0; i < 4097; i++) put(join(repo, ".commandcode", "commands", `${i}.md`), "Command");
    skill(join(home, ".commandcode", "skills"), "personal");
    skill(join(repo, "extra"), "configured");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./extra"] }));
    const names = source.discover(context(home, repo)).map(({ name }) => name);
    expect(names).toContain("skill:personal");
    expect(names).toContain("skill:configured");
  });

  it("matches the pinned canonical builtins", () => {
    expect(new Set(source.builtins)).toEqual(new Set([...PINNED_SLASH_COMMANDS, "new", "sessions", "quit", "issue", "courses"]));
    expect(new Set(source.builtins)).toHaveLength(70);
    expect(source.pin).toBe("1.84.0");
  });

  it("lists a skill by its primary slash name", () => {
    const home = temp();
    skill(join(home, ".commandcode", "skills"), "x");
    expect(source.discover(context(home)).map(({ name }) => name)).toContain("x");
    expect(source.discover(context(home)).map(({ name }) => name)).toContain("agent-browser");
    expect(paneCommands("cmd", null, home).some(({ name }) => name === "x")).toBe(true);
  });

  it("uses skill: only when its name shadows a builtin", () => {
    const home = temp();
    skill(join(home, ".commandcode", "skills"), "compact");
    skill(join(home, ".commandcode", "skills"), "x");
    const skills = source.discover(context(home)).filter(({ source }) => source === "skill");
    expect(skills.map(({ name }) => name)).toContain("skill:compact");
    expect(skills.map(({ name }) => name)).toContain("x");
    expect(skills.map(({ name }) => name)).toContain("skill:loop");
    expect(source.skillsOverrideBuiltins).not.toBe(true);
  });

  it("loads nested custom commands with their parent label", () => {
    const home = temp();
    put(join(home, ".commandcode", "commands", "frontend", "component.md"), "Build a component");
    expect(source.discover(context(home))).toContainEqual(expect.objectContaining({
      name: "component",
      description: "frontend · Build a component",
    }));
  });

  it("lists a command a project command folder links in from outside the repository", () => {
    // Command Code 1.84.0 loadCommandsFromDirectory stats each entry (links followed) and has no root check,
    // so a linked folder's commands run, and a same-name skill is reached only as /skill:<name>.
    const home = temp();
    const repo = temp();
    put(join(repo, ".git"), "");
    const outside = join(temp(), "shared-commands");
    const linked = join(outside, "deploy.md");
    put(linked, "Shared deploy");
    mkdirSync(join(repo, ".commandcode", "commands"), { recursive: true });
    symlinkSync(outside, join(repo, ".commandcode", "commands", "team"), "dir");
    skill(join(home, ".commandcode", "skills"), "deploy");
    const rows = source.discover(context(home, repo));
    expect(rows.find(({ name }) => name === "deploy")).toEqual(expect.objectContaining({ source: "project", description: "team · Shared deploy", id: realpathSync(linked) }));
    expect(rows.map(({ name }) => name)).toContain("skill:deploy");
  });

  it("deduplicates a symlinked skill by canonical path", () => {
    const home = temp();
    const root = join(home, ".commandcode", "skills");
    const target = skill(root, "x");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(join(target, ".."), join(home, ".agents", "skills", "linked"), "dir");
    const rows = source.discover(context(home)).filter(({ name }) => name === "x");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(realpathSync(target));
  });

  it("carries canonical IDs through the pane catalog and has the model builtin", () => {
    const home = temp();
    skill(join(home, ".commandcode", "skills"), "x");
    const rows = paneCommands("cmd", null, home);
    expect(rows.some(({ name, source }) => name === "model" && source === "builtin")).toBe(true);
    expect(rows.find(({ name }) => name === "x")?.id).toBe(realpathSync(join(home, ".commandcode", "skills", "x", "SKILL.md")));
  });

  it("pins each distinct command form class and uses per-form terminal behavior", () => {
    expect(source.forms?.["compact"]).toEqual([{ match: "bare", interaction: "none" }]);
    expect(source.forms?.["goal"]?.find(({ match }) => match === "bare")?.interaction).toBe("unknown");
    expect(source.forms?.["model"]).toEqual([
      { match: "bare", interaction: "terminal" },
      { match: "other", interaction: "none" },
    ]);
    expect(source.forms?.["config"]).toEqual([
      { match: "bare", interaction: "terminal" },
      { match: "other", interaction: "terminal" },
    ]);
    expect(source.forms?.["mode"]).toEqual([
      { match: "bare", interaction: "terminal" },
      { match: "other", interaction: "none" },
    ]);
    expect(source.forms?.["rc"]?.find(({ match }) => match === "bare")?.interaction).toBe("terminal");
    expect(source.forms?.["plans"]).toContainEqual({ match: "other", interaction: "terminal" });
    expect(source.forms?.["worktree"]).toContainEqual({ match: { sub: "list" }, interaction: "terminal" });
    expect(source.forms?.["rc"]).toContainEqual({ match: { sub: "status" }, interaction: "terminal" });
    expect(source.forms?.["memory"]).toEqual([{ match: "bare", interaction: "terminal" }]);
    for (const name of ["add-dir", "compact-mode", "context", "language"]) expect(source.forms?.[name]?.[0]).toEqual({ match: "bare", interaction: "terminal" });
    expect(source.forms?.["language"]?.[1]).toEqual({ match: "other", interaction: "none" });
    expect(source.forms?.["design"]?.find(({ match }) => match === "bare")?.interaction).toBe("terminal");
    expect(paneCommands("cmd", null, temp()).find(({ name }) => name === "model")?.visibility).not.toBe("terminal");
    const model = paneCommands("cmd", null, temp()).find(({ name }) => name === "model")!;
    expect(typedTerminalCommand([model], "/model")).toBe(model);
    expect(typedTerminalCommand([model], "/model gpt-5")).toBeNull();
  });

  it("keeps only well-formed subcommand and other match rules", () => {
    expect(source.forms?.["model"]?.some((form) => typeof form.match === "object" && form.match.sub === "*")).toBe(false);
    expect(source.forms?.["model"]?.some((form) => form.match === "other")).toBe(true);
  });

  it("hides non-invocable skills and skills disabled in user or project settings", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "app");
    mkdirSync(cwd, { recursive: true });
    skill(join(home, ".commandcode", "skills"), "hidden");
    put(join(home, ".commandcode", "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: hidden\nuser-invocable: false\n---\n");
    skill(join(home, ".commandcode", "skills"), "user-disabled");
    put(join(home, ".commandcode", "settings.json"), JSON.stringify({ disabledSkills: ["user-disabled"] }));
    skill(join(repo, ".commandcode", "skills"), "project-disabled");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ disabledSkills: ["project-disabled"] }));
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).not.toContain("hidden");
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).not.toContain("user-disabled");
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).not.toContain("project-disabled");
  });

  it("resolves relative user and project skill roots from the project root", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "src");
    mkdirSync(cwd, { recursive: true });
    skill(join(repo, "vendor", "skills"), "project-extra");
    skill(join(repo, "team", "skills"), "user-extra");
    put(join(home, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./team/skills"] }));
    expect(source.discover(context(home, cwd)).map(({ name }) => name)).toContain("user-extra");
    expect(source.discover(context(home, cwd)).find(({ name }) => name === "user-extra")?.origin).toBe("user");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./vendor/skills"] }));
    const names = source.discover(context(home, cwd)).map(({ name }) => name);
    expect(names).toContain("project-extra");
    expect(names).not.toContain("user-extra");
  });

  it("reads a custom command's description from its first 64 KiB only", () => {
    const home = temp();
    put(join(home, ".commandcode", "commands", "huge.md"), "x".repeat(2 * 1024 * 1024));
    const huge = source.discover(context(home)).find(({ name }) => name === "huge");
    expect(huge?.description.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps the catalog when a configured skill path is a file", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    put(join(repo, "loose.md"), "---\nname: loose\ndescription: Loose\n---\n");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./loose.md"] }));
    const names = source.discover(context(home, repo)).map(({ name }) => name);
    expect(names).toContain("agent-browser");
  });

  it("lets settings.local.json replace project skill locations at highest priority", () => {
    const home = temp();
    const repo = join(temp(), "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "src");
    mkdirSync(cwd, { recursive: true });
    skill(join(repo, "vendor", "base-skills"), "base-extra");
    skill(join(repo, "vendor", "local-skills"), "local-extra");
    put(join(repo, ".commandcode", "settings.json"), JSON.stringify({ skills: ["./vendor/base-skills"] }));
    put(join(repo, ".commandcode", "settings.local.json"), JSON.stringify({ skills: ["./vendor/local-skills"] }));
    const names = source.discover(context(home, cwd)).map(({ name }) => name);
    expect(names).toContain("local-extra");
    expect(names).not.toContain("base-extra");
    put(join(repo, ".commandcode", "settings.local.json"), JSON.stringify({ skills: [] }));
    const overridden = source.discover(context(home, cwd)).map(({ name }) => name);
    expect(overridden).not.toContain("local-extra");
    expect(overridden).not.toContain("base-extra");
  });

  it("qualifies skills colliding with builtin aliases and custom commands", () => {
    const home = temp();
    const commandRoot = join(home, ".commandcode", "commands");
    put(join(commandRoot, "help.md"), "Custom help");
    skill(join(home, ".commandcode", "skills"), "new");
    skill(join(home, ".commandcode", "skills"), "help");
    const rows = source.discover(context(home));
    expect(rows.map(({ name }) => name)).toContain("skill:new");
    expect(rows.map(({ name }) => name)).toContain("skill:help");
    expect(rows.some(({ name }) => name === "help")).toBeFalse();
  });

  it("matches custom command collisions without regard to case", () => {
    const home = temp();
    put(join(home, ".commandcode", "commands", "Deploy.md"), "Deploy this project");
    skill(join(home, ".commandcode", "skills"), "deploy");
    const rows = source.discover(context(home));
    expect(rows.map(({ name }) => name)).toContain("Deploy");
    expect(rows.map(({ name }) => name)).toContain("skill:deploy");
    expect(rows.filter(({ name }) => name.toLowerCase() === "deploy")).toHaveLength(1);
  });
});
