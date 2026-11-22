import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { paneCommands } from "../commands.ts";
import { adminSkillsRoot, source } from "./codex.ts";
import { MAX_WALK_FOLDERS } from "./walk.ts";
import type { CommandForm } from "../../shared/protocol.ts";

// Copied from codex-rs/tui/src/slash_command.rs at rust-v0.163.0 (commit 83086188ae0614bd882818ff1aa23f3194962012):
// the SlashCommand enum in presentation order, as built_in_slash_commands() lists it.
// Left out on purpose: `app` (is_visible: macOS and Windows builds only) and `rollout` and `test-approval`
// (debug builds only). `fast` is no built-in there: Codex offers it as a model service-tier command.
const PINNED_SLASH_TABLE = [
  "model", "daybreak", "ide", "permissions", "keymap", "vim", "setup-default-sandbox", "experimental", "approve", "memories",
  "skills", "import", "hooks", "review", "rename", "new", "archive", "delete", "resume", "fork", "worktree", "init", "compact",
  "config", "recap", "plan", "voice", "goal", "agents", "side", "btw", "copy", "export", "raw", "tui", "diff", "mention",
  "status", "daemon", "warnings", "cd", "pwd", "usage", "title", "statusline", "theme", "pets", "mcp", "apps", "plugins",
  "logout", "quit", "exit", "feedback", "ps", "stop", "clear", "subagents", "debug-config", "debug-m-drop", "debug-m-update",
];

// bottom_pane/command_popup.rs:91-93 builds the popup without every `debug*` command and without `apps`:
// those entries are agent-hidden (not listed by Codex, still dispatched when typed).
const POPUP_HIDDEN = ["apps", "debug-config", "debug-m-drop", "debug-m-update"];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-skills-"));
  roots.push(root);
  return { root, home: join(root, "home"), repo: join(root, "repo"), store: join(root, "profile") };
}
function put(path: string, text = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function discover(home: string, options: { cwd?: string | null; environ?: string[]; version?: string | null } = {}) {
  return source.discover({ home, cwd: options.cwd ?? null, repoRoot: null, env: options.environ ?? null, roots: {}, version: options.version ?? null });
}
function skill(root: string, name: string): string {
  const path = join(root, name, "SKILL.md");
  put(path, `---\nname: ${name}\ndescription: First sentence. Second sentence.\n---\nBody\n`);
  return path;
}

describe("Codex skill discovery", () => {
  it("loads ancestor, shared, legacy, system, nested, nameless and linked skills with their origins", () => {
    const { root, home, repo } = fixture();
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    put(join(repo, ".git"));
    skill(join(root, ".agents", "skills"), "outside");
    for (const directory of [repo, join(repo, "packages"), cwd]) skill(join(directory, ".agents", "skills"), "same");
    skill(join(home, ".agents", "skills"), "shared");
    skill(join(home, ".codex", "skills"), "legacy");
    skill(join(home, ".codex", "skills", ".system"), "creator");
    skill(join(cwd, ".codex", "skills"), "unsupported");
    const linked = skill(join(root, "links"), "target");
    symlinkSync(join(linked, ".."), join(home, ".agents", "skills", "link"), "dir");
    skill(join(home, ".agents", "skills", "group"), "nested");
    put(join(home, ".agents", "skills", "missing-description", "SKILL.md"), "---\nname: missing-description\n---\nBody");
    put(join(home, ".agents", "skills", "missing-name", "SKILL.md"), "---\ndescription: Named by its directory\n---\n");
    put(join(home, ".agents", "skills", ".ignore"), "shared/\n");
    const commands = paneCommands("codex", cwd, home).filter((command) => command.source === "skill");
    expect(commands.map(({ name, origin, trigger }) => [name, origin, trigger])).toEqual([
      ["creator", "bundled", "$"], ["legacy", "user", "$"], ["missing-name", "user", "$"], ["nested", "user", "$"],
      ["same", "project", "$"], ["same", "project", "$"], ["same", "project", "$"],
      ["shared", "user", "$"], ["target", "user", "$"], ["unsupported", "project", "$"],
    ]);
    expect(commands.filter((command) => command.name !== "missing-name").every((command) => command.description === "First sentence. Second sentence.")).toBe(true);
  });

  it("uses the pane CODEX_HOME and, before 0.118.0, only direct Markdown prompts", () => {
    const { home, store } = fixture();
    skill(join(home, ".codex", "skills"), "wrong-store");
    skill(join(store, "skills"), "profile");
    put(join(store, "prompts", "review.md"), "---\ndescription: Review staged files\n---\nReview");
    put(join(store, "prompts", "nested", "hidden.md"), "Hidden");
    put(join(store, "prompts", "ignored.txt"), "Ignored");
    const commands = discover(home, { environ: [`CODEX_HOME=${store}`], version: "0.117.0" });
    expect(commands.map(({ name, source, trigger }) => [name, source, trigger])).toEqual([
      ["prompts:review", "user", undefined], ["profile", "skill", "$"],
    ]);
  });

  it("excludes disabled canonical paths including symlink aliases", () => {
    const { home, store } = fixture();
    const disabled = skill(join(store, "skills"), "disabled");
    skill(join(store, "skills"), "enabled");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(join(disabled, ".."), join(home, ".agents", "skills", "alias"), "dir");
    put(join(store, "config.toml"), `[[skills.config]]\npath = ${JSON.stringify(disabled)}\nenabled = false\n`);
    expect(paneCommands("codex", null, home, { environ: [`CODEX_HOME=${store}`] }).filter((command) => command.source === "skill").map((command) => command.name)).toEqual(["enabled"]);
  });

  it("keeps skills discoverable when TOML is malformed", () => {
    const { home } = fixture();
    skill(join(home, ".codex", "skills"), "available");
    put(join(home, ".codex", "config.toml"), "[[skills.config]\nenabled = false");
    expect(paneCommands("codex", null, home).some((command) => command.name === "available")).toBe(true);
  });

  it("loads enabled marketplace plugins and omits disabled or unconfigured ones", () => {
    const { home } = fixture();
    const store = join(home, ".codex");
    skill(join(store, "plugins", "cache", "market", "enabled", "1.0", "skills"), "plugin-skill");
    skill(join(store, "plugins", "cache", "market", "disabled", "1.0", "skills"), "disabled-skill");
    skill(join(store, "plugins", "cache", "other-market", "enabled", "1.0", "skills"), "other-market-skill");
    skill(join(store, "plugins", "cache", "unconfigured", "1.0", "skills"), "unconfigured-skill");
    put(join(store, "config.toml"), '[plugins."enabled@market"]\nenabled = true\n[plugins."disabled@market"]\nenabled = false\n');
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin")).toMatchObject([
      { name: "enabled:plugin-skill", description: "First sentence. Second sentence.", source: "skill", trigger: "$", origin: "plugin",
        id: realpathSync(join(store, "plugins", "cache", "market", "enabled", "1.0", "skills", "plugin-skill", "SKILL.md")) },
    ]);
  });

  it("includes every cached plugin without a plugin table and bounds cache cycles", () => {
    const { home } = fixture();
    const cache = join(home, ".codex", "plugins", "cache");
    skill(join(cache, "simple-plugin", "v1", "skills"), "simple");
    skill(join(cache, "market", "plugin", "v1", "skills"), "marketplace");
    symlinkSync(cache, join(cache, "cycle"), "dir");
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin").map((command) => command.name)).toEqual(["plugin:marketplace", "simple-plugin:simple"]);
  });

  it("skips a stale plugin link without hiding the plugins beside it", () => {
    const { home } = fixture();
    const market = join(home, ".codex", "plugins", "cache", "market");
    for (const index of [1, 2, 3]) {
      skill(join(market, `plugin-${index}`, "1.0", "skills"), `kept-${index}`);
      if (index < 3) symlinkSync(join(market, "gone"), join(market, `stale-${index}`), "dir");
    }
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin").map((command) => command.name)).toEqual(["plugin-1:kept-1", "plugin-2:kept-2", "plugin-3:kept-3"]);
  });

  it("loads a plugin version and its latest link once", () => {
    const { home } = fixture();
    const plugin = join(home, ".codex", "plugins", "cache", "market", "chrome");
    skill(join(plugin, "1.0", "skills"), "control-chrome");
    symlinkSync(join(plugin, "1.0"), join(plugin, "latest"), "dir");
    expect(paneCommands("codex", null, home).filter((command) => command.origin === "plugin").map((command) => command.name)).toEqual(["chrome:control-chrome"]);
  });

  it("carries the pin its builtin table and forms were checked against", () => {
    expect(source.pin).toMatch(/^\d+\.\d+\.\d+$/);
    for (const name of Object.keys(source.forms ?? {})) expect(source.builtins).toContain(name);
    expect(source.builtins).toContain("model");
    expect(source.builtins).toContain("subagents");
  });

  it("lists exactly the builtins of the pinned slash table", () => {
    expect([...source.builtins].sort()).toEqual([...PINNED_SLASH_TABLE].sort());
    expect(new Set(source.builtins).size).toBe(source.builtins.length);
    expect(source.builtins).not.toContain("fast");
    for (const name of Object.keys(source.descriptions ?? {})) expect(source.builtins).toContain(name);
    for (const name of source.builtins) expect(source.descriptions?.[name]).toBeTruthy();
  });

  it("offers the nine former exclusions and the other TUI-only screens as terminal-bound builtins", () => {
    const former = ["resume", "permissions", "agents", "hooks", "mcp", "plugins", "skills", "voice", "theme"];
    const screens = ["config", "setup-default-sandbox"];
    const held = ["keymap", "experimental", "approve", "memories", "import", "new", "archive", "delete", "fork", "worktree", "side", "btw",
      "copy", "tui", "mention", "daemon", "warnings", "cd", "usage", "title", "statusline", "pets", "feedback", "subagents", "vim", "logout"];
    expect([...(source.terminalBound ?? [])].sort()).toEqual([...former, ...screens, ...held].sort());
    for (const name of source.terminalBound ?? []) expect(source.builtins).toContain(name);
    expect(source.builtins).not.toContain("help");
  });

  it("types the forms codex-rs/tui/src/slash_command.rs at rust-v0.163.0 gives each command", () => {
    expect(source.forms).toMatchObject({
      model: [{ match: "bare", interaction: "dialog", dialog: "codex-model" }],
      status: [{ match: "bare", interaction: "terminal" }], diff: [{ match: "bare", interaction: "terminal" }],
      pwd: [{ match: "bare", interaction: "terminal" }], ps: [{ match: "bare", interaction: "terminal" }],
      mcp: [{ match: "bare", interaction: "terminal" }],
      init: [{ match: "bare", interaction: "none" }], compact: [{ match: "bare", interaction: "none" }],
      rename: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
      export: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
      goal: [{ match: "bare", interaction: "unknown" }, { match: { sub: "edit" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
    });
  });

  it("keeps a bare /review in the terminal, where the pinned TUI opens its review preset popup, and sends /review <text>", () => {
    // codex-rs 83086188 tui/src/chatwidget/slash_dispatch.rs:361-367 sends a bare /review to
    // open_review_popup, the "Select a review preset" picker of chatwidget/review_popups.rs:15-65;
    // slash_dispatch.rs:1092-1093 submits /review <text> as ReviewTarget::Custom, a turn of its own
    const review: CommandForm[] = [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }];
    expect(source.forms?.review).toEqual(review);
    const { home } = fixture();
    expect(paneCommands("codex", null, home).find((command) => command.name === "review")?.forms).toEqual(review);
  });

  it("marks what the pinned popup hides as agent-hidden, and nothing else", () => {
    expect([...(source.agentHidden ?? [])].sort()).toEqual([...POPUP_HIDDEN].sort());
    for (const name of POPUP_HIDDEN) {
      expect(source.builtins).toContain(name);
      expect(source.terminalBound ?? []).not.toContain(name);
    }
    const { home } = fixture();
    const rows = paneCommands("codex", null, home).filter((command) => command.source === "builtin");
    for (const row of rows) {
      expect(row.visibility).toBe(POPUP_HIDDEN.includes(row.name) ? "agent-hidden" : source.terminalBound?.includes(row.name) ? "terminal" : "offered");
    }
    expect(rows.find((command) => command.name === "apps")?.visibility).toBe("agent-hidden");
  });

  it("lists every former exclusion with visibility terminal in the pane catalog", () => {
    const { home } = fixture();
    const rows = paneCommands("codex", null, home).filter((command) => command.source === "builtin");
    for (const name of ["resume", "permissions", "agents", "hooks", "mcp", "plugins", "skills", "voice", "theme"]) {
      expect(rows.find((command) => command.name === name)?.visibility).toBe("terminal");
    }
    expect(rows.find((command) => command.name === "model")?.visibility).toBe("offered");
  });
});

describe("Codex catalog from the pinned loader", () => {
  const promptHome = () => {
    const { home } = fixture();
    put(join(home, ".codex", "prompts", "foo.md"), "---\ndescription: Custom prompt\n---\nBody");
    return home;
  };
  const prompts = (home: string, version: string | null) => discover(home, { version }).filter((command) => command.name.startsWith("prompts:")).map((command) => command.name);

  it("offers no prompts:<name> from 0.118.0 on, nor when the version is unknown", () => {
    const home = promptHome();
    expect(prompts(home, "0.162.1")).toEqual([]);
    expect(prompts(home, "0.118.0")).toEqual([]);
    expect(prompts(home, null)).toEqual([]);
  });

  it("offers no prompts:<name> in the pane catalog for a version-less or current Codex", () => {
    const home = promptHome();
    for (const version of [undefined, null, "0.162.1"]) {
      expect(paneCommands("codex", null, home, {}, version).some((command) => command.name.startsWith("prompts:"))).toBe(false);
    }
    expect(paneCommands("codex", null, home, {}, "0.117.0").some((command) => command.name === "prompts:foo")).toBe(true);
  });

  it("still offers prompts:<name> for a version before 0.118.0", () => {
    expect(prompts(promptHome(), "0.117.0")).toEqual(["prompts:foo"]);
    expect(prompts(promptHome(), "0.9.4")).toEqual(["prompts:foo"]);
  });

  it("walks skill roots to depth 6 through directory links and never through a SKILL.md link", () => {
    const { root, home } = fixture();
    const base = join(home, ".agents", "skills");
    skill(join(base, "a"), "depth-two");
    skill(join(base, "a", "b", "c", "d", "e"), "depth-six");
    skill(join(base, "a", "b", "c", "d", "e", "x"), "depth-seven");
    skill(join(base, ".hidden"), "hidden");
    const outside = skill(join(root, "outside"), "linked-dir");
    symlinkSync(join(outside, ".."), join(base, "a", "link"), "dir");
    const real = skill(join(root, "elsewhere"), "file-link");
    put(join(base, "file-link", "placeholder"), "");
    symlinkSync(real, join(base, "file-link", "SKILL.md"));
    const names = discover(home).map((command) => command.name);
    expect(names).toContain("depth-two");
    expect(names).toContain("depth-six");
    expect(names).toContain("linked-dir");
    expect(names).not.toContain("depth-seven");
    expect(names).not.toContain("hidden");
    expect(names).not.toContain("file-link");
  });

  it("names a skill after its directory when the name is missing or blank", () => {
    const { home } = fixture();
    put(join(home, ".agents", "skills", "from-dir", "SKILL.md"), "---\ndescription: No name\n---\n");
    put(join(home, ".agents", "skills", "blank", "SKILL.md"), '---\nname: "  "\ndescription: Blank name\n---\n');
    expect(discover(home).map((command) => command.name).sort()).toEqual(["blank", "from-dir"]);
  });

  it("keeps same-name skills from different roots with distinct ids and loads a file reached twice once", () => {
    const { home } = fixture();
    const first = skill(join(home, ".agents", "skills"), "same");
    const second = skill(join(home, ".codex", "skills"), "same");
    symlinkSync(join(first, ".."), join(home, ".codex", "skills", "alias"), "dir");
    const rows = discover(home).filter((command) => command.name === "same");
    expect(rows.map((command) => command.id).sort()).toEqual([realpathSync(first), realpathSync(second)].sort());
    const catalog = paneCommands("codex", null, home).filter((command) => command.name === "same");
    expect(catalog.map((command) => command.id).sort()).toEqual([realpathSync(first), realpathSync(second)].sort());
  });

  it("qualifies a plugin skill with the name in its plugin manifest, else its cache directory", () => {
    const { home } = fixture();
    const cache = join(home, ".codex", "plugins", "cache");
    skill(join(cache, "market", "dir-named", "1.0", "skills"), "alpha");
    skill(join(cache, "market", "manifest-dir", "1.0", "skills"), "beta");
    put(join(cache, "market", "manifest-dir", "1.0", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "declared" }));
    expect(discover(home).filter((command) => command.origin === "plugin").map((command) => command.name).sort()).toEqual(["declared:beta", "dir-named:alpha"]);
  });

  it("qualifies a plugin skill under any root with the name of the manifest above it", () => {
    const { repo, home } = fixture();
    const cwd = join(repo, "app");
    mkdirSync(cwd, { recursive: true });
    put(join(repo, ".git"));
    const base = join(cwd, ".agents", "skills");
    skill(join(base, "nested-plugin", "skills"), "search");
    put(join(base, "nested-plugin", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "nested" }));
    skill(base, "plain");
    const rows = discover(home, { cwd }).filter((command) => command.origin === "project");
    expect(rows.map((command) => command.name).sort()).toEqual(["nested:search", "plain"]);
  });

  it("loads project .codex/skills from the repository's directories", () => {
    const { repo, home } = fixture();
    const cwd = join(repo, "app");
    mkdirSync(cwd, { recursive: true });
    put(join(repo, ".git"));
    skill(join(repo, ".codex", "skills"), "repo-level");
    skill(join(cwd, ".codex", "skills"), "app-level");
    expect(discover(home, { cwd }).filter((command) => command.origin === "project").map((command) => command.name).sort()).toEqual(["app-level", "repo-level"]);
  });

  it("reads the Windows admin root from ProgramData and /etc/codex/skills elsewhere", () => {
    expect(adminSkillsRoot("win32", ["ProgramData=C:\\ProgramData"], undefined)).toBe(win32.join("C:\\ProgramData", "OpenAI", "Codex", "skills"));
    expect(adminSkillsRoot("win32", null, "D:\\PD")).toBe(win32.join("D:\\PD", "OpenAI", "Codex", "skills"));
    expect(adminSkillsRoot("win32", null, undefined)).toBeNull();
    expect(adminSkillsRoot("linux", null, undefined)).toBe("/etc/codex/skills");
  });
});

describe("Codex skill identity", () => {
  it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const { home } = fixture();
    put(join(home, ".codex", "skills", "aliased", "SKILL.md"), "---\nname: aliased\ndescription: Aliased skill\n---\n");
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(join(home, ".codex", "skills"), join(home, ".agents", "skills"), "dir");
    const rows = paneCommands("codex", null, home).filter((command) => command.name === "aliased");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", trigger: "$", id: realpathSync(join(home, ".codex", "skills", "aliased", "SKILL.md")) });
  });
});

it("resolves at most a walk's folder budget in a folder whose skill links fan out, as GET /api/agent/commands lets any folder be named", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-skill-fanout-"));
  const folder = join(root, "proj");
  mkdirSync(join(folder, ".git"), { recursive: true });
  const base = join(folder, ".agents", "skills");
  const levels = Array.from({ length: 12 }, (_, depth) => join(base, `level${depth}`));
  for (const level of levels) mkdirSync(level, { recursive: true });
  for (let depth = 0; depth + 1 < levels.length; depth++) for (let link = 0; link < 5; link++) symlinkSync(levels[depth + 1]!, join(levels[depth]!, `link${link}`));
  const resolved = spyOn(nodeFs, "realpathSync");
  try {
    paneCommands("codex", folder, join(root, "home"));
    expect(resolved.mock.calls.length).toBeLessThanOrEqual(MAX_WALK_FOLDERS + 16);
  } finally {
    resolved.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
