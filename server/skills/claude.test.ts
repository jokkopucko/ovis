import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { claudeCommandNames, comparableName, source } from "./claude.ts";
import type { AgentCommandContext } from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "claude-menu-"));
  roots.push(home);
  const repo = join(home, "repo");
  const cwd = join(repo, "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(cwd);
  return { home, repo, cwd };
}
function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function ctx(home: string, cwd: string, environ: string[] | null = null): AgentCommandContext {
  return { home, cwd, repoRoot: null, env: environ, roots: {} };
}
const found = (home: string, cwd: string) => source.discover(ctx(home, cwd)).filter(({ source: kind }) => kind !== "builtin");
const withBundled = (home: string, cwd: string) => source.discover(ctx(home, cwd));
const real = (path: string): string => realpathSync(path);
function skill(root: string, name: string, fields = "", body = "Probe skill"): void {
  put(join(root, name, "SKILL.md"), `---\n${fields}\n---\n${body}\n`);
}

describe("Claude discovery", () => {
  it("loads personal and nearest ancestor skills before commands, without descendants", () => {
    const { home, repo, cwd } = fixture();
    skill(join(home, ".claude/skills"), "shared", "description: Personal");
    skill(join(repo, ".claude/skills"), "shared", "description: Project");
    skill(join(repo, ".claude/skills"), "parent");
    skill(join(cwd, ".claude/skills"), "local", "name: renamed");
    skill(join(cwd, ".claude/skills"), "hidden", "user-invocable: false");
    skill(join(cwd, "sub/.claude/skills"), "deep");
    put(join(home, ".claude/commands/shared.md"), "Legacy command");
    put(join(repo, ".claude/commands/team/check.md"), "Check");
    const commands = paneCommands("claude", cwd, home).filter(({ source }) => source !== "builtin");
    expect(commands).toMatchObject([
      { name: "parent", description: "Probe skill", source: "skill", origin: "project", id: real(join(repo, ".claude/skills/parent/SKILL.md")) },
      { name: "renamed", description: "Probe skill", source: "skill", origin: "project", id: real(join(cwd, ".claude/skills/local/SKILL.md")) },
      { name: "shared", description: "Personal", source: "skill", origin: "user", id: real(join(home, ".claude/skills/shared/SKILL.md")) },
      { name: "team:check", description: "Check", source: "project", id: real(join(repo, ".claude/commands/team/check.md")) },
    ]);
  });

  it("honors the process config directory for synced skills, plugins and commands", () => {
    const { home, cwd } = fixture();
    const config = join(home, "custom");
    const plugin = join(home, "plugin");
    skill(join(home, ".claude/skills"), "wrong-home");
    skill(join(config, "skills/synced"), "probe-skill");
    skill(join(plugin, "skills"), "folder", "name: named");
    skill(join(plugin, "skills"), "hidden", "user-invocable: false");
    put(join(plugin, "commands/check.md"), "Check");
    put(join(config, "commands/local.md"), "Local");
    put(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "tools@market": true, "off@market": false } }));
    put(join(config, "plugins/installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: plugin }], "off@market": [{ installPath: plugin }] } }));
    const commands = paneCommands("claude", cwd, home, { environ: [`CLAUDE_CONFIG_DIR=${config}`] }).filter(({ source }) => source !== "builtin");
    expect(commands).toMatchObject([
      { name: "local", description: "Local", source: "user", id: real(join(config, "commands/local.md")) },
      { name: "probe-skill", description: "Probe skill", source: "skill", origin: "user", id: real(join(config, "skills/synced/probe-skill/SKILL.md")) },
      { name: "tools:check", description: "Check", source: "plugin", id: real(join(plugin, "commands/check.md")) },
      { name: "tools:named", description: "Probe skill", source: "skill", origin: "plugin", id: real(join(plugin, "skills/folder/SKILL.md")) },
    ]);
  });

  it("falls back only to the main checkout when a linked worktree has no skill roots", () => {
    const { home, repo } = fixture();
    const worktree = join(home, "linked");
    const sibling = join(home, "sibling");
    const gitdir = join(repo, ".git/worktrees/linked");
    put(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
    put(join(gitdir, "commondir"), "../..\n");
    skill(join(repo, ".claude/skills"), "main");
    skill(join(sibling, ".claude/skills"), "untracked-sibling");
    mkdirSync(join(worktree, ".claude/skills"), { recursive: true });
    expect(paneCommands("claude", worktree, home).filter(({ source }) => source === "skill").map(({ name }) => name)).toEqual(["main"]);
    skill(join(worktree, ".claude/skills"), "own");
    expect(paneCommands("claude", worktree, home).filter(({ source }) => source === "skill").map(({ name }) => name)).toEqual(["own"]);
  });

  it("offers the current reference's names, drops removed ones and keeps review as code-review's alias", () => {
    const { home, cwd } = fixture();
    const names = new Set([...source.builtins, ...withBundled(home, cwd).map(({ name }) => name)]);
    for (const name of ["agents", "heapdump", "setup-bedrock", "setup-vertex", "code-review", "review", "config", "theme", "batch", "loop"]) expect(names.has(name)).toBe(true);
    for (const name of ["pr-comments", "vim", "ultraplan"]) expect(names.has(name)).toBe(false);
    expect(new Set(source.builtins).size).toBe(source.builtins.length);
    expect(source.forms?.review).toEqual(source.forms?.["code-review"]);
    expect(source.descriptions?.review).toContain("/code-review");
    expect(source.pin).toBe("2.1.301");
    expect(source.skillsOverrideBuiltins).toBe(true);
  });

  it("offers every screen Chat cannot see through as terminal-bound and marks exactly the menu-hidden four", () => {
    expect([...(source.terminalBound ?? [])].sort()).toEqual([
      "add-dir", "artifacts", "auto-mode-setup", "autofix-pr", "bug", "cd", "chrome", "config", "copy", "cost", "design-login", "desktop",
      "diff", "feedback", "help", "hooks", "ide", "import", "install-github-app", "install-slack-app", "keybindings", "login", "logout",
      "mcp", "memory", "mobile", "passes", "permissions", "plugin", "powerup", "privacy-settings", "radio", "rate-limit-options",
      "remote-control", "remote-env", "resume", "sandbox", "scroll-speed", "skill-doctor", "skills", "stats", "status", "stickers", "tasks",
      "teleport", "terminal-setup", "theme", "ultrareview", "upgrade", "usage", "usage-credits", "voice", "web-setup", "workflows",
    ]);
    for (const name of source.terminalBound ?? []) expect(source.builtins).toContain(name);
    expect([...(source.agentHidden ?? [])].sort()).toEqual(["agents", "heapdump", "setup-bedrock", "setup-vertex"]);
    for (const name of source.agentHidden ?? []) expect(source.builtins).toContain(name);
  });

  it("describes the forms the block names and leaves the rest unannotated", () => {
    expect(source.forms).toEqual({
      model: [{ match: "bare", interaction: "dialog", dialog: "claude-model" }, { match: "other", interaction: "none" }],
      effort: [{ match: "bare", interaction: "dialog", dialog: "claude-effort" }, { match: "other", interaction: "none" }],
      goal: [{ match: "bare", interaction: "dialog", dialog: "claude-goal" }, { match: { sub: "clear" }, interaction: "none" }, { match: "other", interaction: "none" }],
      btw: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
      rewind: [{ match: "bare", interaction: "terminal" }],
      fast: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
      autocompact: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
      advisor: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
      export: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "none" }],
      plan: [{ match: "bare", interaction: "unknown" }, { match: { sub: "open" }, interaction: "terminal" }, { match: "other", interaction: "unknown" }],
      review: [{ match: "bare", interaction: "unknown" }],
      "code-review": [{ match: "bare", interaction: "unknown" }],
    });
    const { home, cwd } = fixture();
    const known = new Set([...source.builtins, ...withBundled(home, cwd).map(({ name }) => name)]);
    for (const name of Object.keys(source.forms ?? {})) expect(known.has(name)).toBe(true);
  });

  it("hides skills with user-invocable off in any spelling the frontmatter accepts", () => {
    const { home, cwd } = fixture();
    const root = join(cwd, ".claude/skills");
    skill(root, "plain");
    for (const [name, value] of [["a", "false"], ["b", "no"], ["c", "Off"], ["d", "0"]] as const) skill(root, name, `user-invocable: ${value}`);
    skill(root, "e", "user-invocable: true");
    expect(found(home, cwd).map(({ name }) => name).sort()).toEqual(["e", "plain"]);
  });

  it("drops a skill whose skillOverrides entry is off, in any settings scope, and brings it back when removed", () => {
    const { home, repo, cwd } = fixture();
    skill(join(home, ".claude/skills"), "deploy");
    skill(join(home, ".claude/skills"), "keep");
    skill(join(home, ".claude/skills"), "user-only");
    skill(join(repo, ".claude/skills"), "project-off");
    put(join(home, ".claude/commands/legacy.md"), "Legacy");
    const names = () => found(home, cwd).map(({ name }) => name).sort();
    expect(names()).toEqual(["deploy", "keep", "legacy", "project-off", "user-only"]);
    put(join(home, ".claude/settings.json"), JSON.stringify({ skillOverrides: { deploy: "off", "user-only": "user-invocable-only", legacy: "off" } }));
    put(join(repo, ".claude/settings.local.json"), JSON.stringify({ skillOverrides: { "project-off": "off" } }));
    expect(names()).toEqual(["keep", "user-only"]);
    put(join(repo, ".claude/settings.local.json"), JSON.stringify({ skillOverrides: { deploy: "on" } }));
    expect(names()).toEqual(["deploy", "keep", "project-off", "user-only"]);
    rmSync(join(home, ".claude/settings.json"));
    rmSync(join(repo, ".claude/settings.local.json"));
    expect(names()).toEqual(["deploy", "keep", "legacy", "project-off", "user-only"]);
  });

  it("leaves plugin skills alone when skillOverrides names them", () => {
    const { home, cwd } = fixture();
    const plugin = join(home, "plugin");
    skill(join(plugin, "skills"), "review");
    put(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "tools@market": true }, skillOverrides: { review: "off" } }));
    put(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: plugin }] } }));
    expect(found(home, cwd).map(({ name }) => name)).toEqual(["tools:review"]);
  });

  it("skips reserved names, and lists a synced skill by its short name unless another command has it", () => {
    const { home, repo, cwd } = fixture();
    const personal = join(home, ".claude/skills");
    skill(personal, "synced", "description: Authored");
    skill(join(repo, ".claude/skills"), "Synced");
    skill(personal, "anthropic-skills");
    put(join(home, ".claude/commands/anthropic-skills/x.md"), "Reserved");
    put(join(home, ".claude/commands/anthropic-skills.md"), "Reserved");
    skill(join(personal, "synced"), "pdf");
    skill(join(personal, "synced"), "deploy");
    skill(join(personal, "synced"), "compact");
    skill(personal, "deploy");
    const listed = found(home, cwd);
    expect(listed.map(({ name }) => name).sort()).toEqual(["anthropic-skills:compact", "anthropic-skills:deploy", "deploy", "pdf"]);
    expect(listed.find(({ name }) => name === "deploy")?.id).toBe(real(join(personal, "deploy/SKILL.md")));
  });

  it("compares synced and local names ignoring case, spacing and compatibility forms", () => {
    const { home, cwd } = fixture();
    skill(join(home, ".claude/skills"), "commit");
    skill(join(home, ".claude/skills/synced"), "Commit");
    skill(join(home, ".claude/skills/synced"), "Compact");
    skill(join(home, ".claude/skills/synced"), "ｄｅｐｌｏｙ");
    skill(join(home, ".claude/skills"), "deploy");
    skill(join(home, ".claude/skills/synced"), "fresh");
    expect(found(home, cwd).map(({ name }) => name).sort()).toEqual(["anthropic-skills:Commit", "anthropic-skills:Compact", "anthropic-skills:ｄｅｐｌｏｙ", "commit", "deploy", "fresh"]);
  });

  it("treats dash variants as the plain hyphen when a synced name meets a local one", () => {
    const { home, cwd } = fixture();
    const dashes = ["\u2010", "\u2011", "\u2013", "\u2014", "\u2212", "\uFE58", "\uFF0D"];
    dashes.forEach((dash, index) => {
      skill(join(home, ".claude/skills"), `local${index}-name`);
      skill(join(home, ".claude/skills/synced"), `local${index}${dash}name`);
    });
    skill(join(home, ".claude/skills/synced"), "plain\u2010free");
    const names = found(home, cwd).map(({ name }) => name).sort();
    for (const [index, dash] of dashes.entries()) {
      expect(names).toContain(`anthropic-skills:local${index}${dash}name`);
      expect(names).not.toContain(`local${index}${dash}name`);
    }
    expect(names).toContain("plain\u2010free");
  });

  it.each([
    ["U+00AD soft hyphen", "\u00AD"], ["U+034F combining grapheme joiner", "\u034F"], ["U+200B zero width space", "\u200B"],
    ["U+2060 word joiner", "\u2060"], ["U+FEFF byte order mark", "\uFEFF"], ["U+FE0F variation selector 16", "\uFE0F"],
  ])("ignores %s when a synced name meets a local one", (_label, invisible) => {
    const { home, cwd } = fixture();
    skill(join(home, ".claude/skills"), "foo-bar");
    skill(join(home, ".claude/skills/synced"), `foo${invisible}-bar`);
    const names = found(home, cwd).map(({ name }) => name);
    expect(names).toContain(`anthropic-skills:foo${invisible}-bar`);
    expect(names).not.toContain(`foo${invisible}-bar`);
    expect(names).toContain("foo-bar");
  });

  describe("the name a synced skill is compared by", () => {
    const invisibles = ["\u034F", "\u200B", "\u00AD", " ", "\uFEFF"];
    const bases = ["café", "foo-bar", "Commit", "ｄｅｐｌｏｙ", "a\u0301b"];
    const forms = (name: string): string[] => [name, name.normalize("NFC"), name.normalize("NFD"), name.normalize("NFKD")];

    it("ignores an invisible character or a space at every position, and composed against decomposed forms", () => {
      for (const base of bases) {
        const key = comparableName(base);
        for (const form of forms(base)) {
          expect(comparableName(form)).toBe(key);
          const chars = [...form];
          for (let at = 0; at <= chars.length; at++) {
            for (const invisible of invisibles) {
              const inserted = [...chars.slice(0, at), invisible, ...chars.slice(at)].join("");
              expect(comparableName(inserted), JSON.stringify(inserted)).toBe(key);
            }
          }
        }
      }
    });

    it("is a fixed point: comparing a key again gives the same key", () => {
      for (const base of bases) for (const form of forms(base)) {
        const key = comparableName(form);
        expect(comparableName(key)).toBe(key);
      }
    });

    it("converges when lowercasing makes a combining sequence", () => {
      // U+0130 lowercases to i + U+0307, which an ignorable beside it could once have kept from composing
      for (const base of ["\u0130stanbul", "caf\u0130", "\u0130\u0130"]) {
        const key = comparableName(base);
        expect(comparableName(key)).toBe(key);
        expect(comparableName(base.replaceAll("\u0130", "i\u0307"))).toBe(key);
        for (const invisible of invisibles) {
          const chars = [...base];
          for (let at = 0; at <= chars.length; at++) {
            const inserted = [...chars.slice(0, at), invisible, ...chars.slice(at)].join("");
            expect(comparableName(inserted), JSON.stringify(inserted)).toBe(key);
            expect(comparableName(comparableName(inserted))).toBe(key);
          }
        }
      }
    });

    it("converges when compatibility mapping produces a mark that composes only on a second pass", () => {
      // NFKC maps the spacing diaeresis U+00A8 to space + U+0308; once the space is stripped the mark composes with the letter
      for (const [spacing, composed] of [["a\u00A8", "\u00E4"], ["e\u00B4", "\u00E9"], ["a\u02DA", "\u00E5"]] as const) {
        const key = comparableName(spacing);
        expect(comparableName(key), JSON.stringify(spacing)).toBe(key);
        expect(key).toBe(comparableName(composed));
      }
    });

    it("folds case the way Unicode does: final sigma, sharp s and the rest of the case-only pairs", () => {
      expect(comparableName("ΟΣ")).toBe(comparableName("οσ"));
      expect(comparableName("ΟΣΟΣ")).toBe(comparableName("οσος"));
      expect(comparableName("Straße")).toBe(comparableName("STRASSE"));
      // every code point whose upper and lower case differ is the same name in either case, alone or inside a word;
      // the Turkic dotless i is the one pair that stays apart (it has no common case folding)
      const apart: string[] = [];
      for (let cp = 0; cp < 0x30000; cp++) {
        if (cp >= 0xD800 && cp < 0xE000) continue;
        const c = String.fromCodePoint(cp);
        const upper = c.toUpperCase(), lower = c.toLowerCase();
        if (upper === lower) continue;
        for (const [a, b] of [[upper, lower], [`a${upper}b`, `a${lower}b`], [`x${upper}`, `x${lower}`]] as const) {
          if (comparableName(a) !== comparableName(b)) { apart.push(cp.toString(16)); break; }
        }
      }
      expect(apart).toEqual(["131"]);
    });

    it("keeps the dotless i apart from i, but not capital I from i", () => {
      expect(comparableName("\u0131")).not.toBe(comparableName("i"));
      expect(comparableName("\u0131")).not.toBe(comparableName("I"));
      expect(comparableName("I")).toBe(comparableName("i"));
    });

    it("lists a synced skill under its namespace when only the case of a Greek name differs", () => {
      const { home, cwd } = fixture();
      skill(join(home, ".claude/skills"), "οσ");
      skill(join(home, ".claude/skills/synced"), "ΟΣ");
      const names = found(home, cwd).map(({ name }) => name);
      expect(names).toContain("anthropic-skills:ΟΣ");
      expect(names).not.toContain("ΟΣ");
    });

    it("keeps names that differ apart", () => {
      expect(comparableName("café")).not.toBe(comparableName("cafe"));
      expect(comparableName("foo-bar")).not.toBe(comparableName("foobar"));
    });
  });

  it("keeps plugin-authoring, a built-in plugin's skill, whatever skillOverrides says", () => {
    const { home, cwd } = fixture();
    put(join(home, ".claude/settings.json"), JSON.stringify({ skillOverrides: { "plugin-authoring": "off", verify: "off" } }));
    const rows = paneCommands("claude", cwd, home);
    expect(rows.find((row) => row.name === "plugin-authoring")?.visibility).toBe("offered");
    expect(rows.find((row) => row.name === "verify")).toBeUndefined();
  });

  it("names Claude's own commands apart from its bundled skills", () => {
    expect(claudeCommandNames()).toEqual(expect.arrayContaining(["compact", "plugin-authoring", "config", "heapdump"]));
    for (const skill of ["doctor", "code-review", "simplify"]) expect(claudeCommandNames()).not.toContain(skill);
    expect(new Set(claudeCommandNames()).size).toBe(claudeCommandNames().length);
  });

  it("gives every discovered row a stable id", () => {
    const { home, repo, cwd } = fixture();
    skill(join(repo, ".claude/skills"), "one");
    put(join(repo, ".claude/commands/two.md"), "Two");
    const rows = found(home, cwd);
    expect(rows.map(({ id }) => id).sort()).toEqual([real(join(repo, ".claude/commands/two.md")), real(join(repo, ".claude/skills/one/SKILL.md"))].sort());
  });

  it("hides a bundled skill whose skillOverrides entry is off, and leaves static builtins alone", () => {
    const { home, cwd } = fixture();
    const rows = () => paneCommands("claude", cwd, home);
    expect(rows().find((row) => row.name === "code-review")?.visibility).toBe("offered");
    put(join(home, ".claude/settings.json"), JSON.stringify({ skillOverrides: { "code-review": "off", doctor: "off", compact: "off", loop: "name-only" } }));
    for (const name of ["code-review", "doctor"]) expect(rows().find((row) => row.name === name)).toBeUndefined();
    expect(rows().find((row) => row.name === "review")?.visibility).toBe("offered");
    expect(rows().filter((row) => row.name === "code-review")).toHaveLength(0);
    expect(rows().find((row) => row.name === "compact")?.visibility).toBe("offered");
    expect(rows().find((row) => row.name === "loop")?.visibility).toBe("offered");
    rmSync(join(home, ".claude/settings.json"));
    expect(rows().find((row) => row.name === "code-review")?.visibility).toBe("offered");
  });

  it("lets a skill replace a bundled one of the same name, marked as shadowing it", () => {
    const { home, cwd } = fixture();
    skill(join(cwd, ".claude/skills"), "doctor");
    const rows = paneCommands("claude", cwd, home).filter((row) => row.name === "doctor");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", shadows: "builtin" });
  });

  it("honors user-invocable off in a legacy command file", () => {
    const { home, repo, cwd } = fixture();
    put(join(repo, ".claude/commands/hidden.md"), "---\nuser-invocable: false\n---\nHidden");
    put(join(repo, ".claude/commands/team/inner.md"), "---\nuser-invocable: no\n---\nHidden");
    put(join(home, ".claude/commands/personal.md"), "---\nuser-invocable: false\n---\nHidden");
    put(join(repo, ".claude/commands/shown.md"), "---\nuser-invocable: true\n---\nShown");
    expect(found(home, cwd).map(({ name }) => name)).toEqual(["shown"]);
  });

  it("skips a skill in a reserved folder whatever its frontmatter name says", () => {
    const { home, repo, cwd } = fixture();
    skill(join(repo, ".claude/skills"), "anthropic-skills", "name: sneaky");
    skill(join(repo, ".claude/skills"), "Anthropic-Skills:x", "name: sneaky2");
    skill(join(home, ".claude/skills"), "anthropic-skills", "name: sneaky3");
    skill(join(repo, ".claude/skills"), "fine", "name: anthropic-skills:renamed");
    skill(join(repo, ".claude/skills"), "ok");
    expect(found(home, cwd).map(({ name }) => name)).toEqual(["ok"]);
  });

  it("lists the screens with visibility terminal and the hidden four as agent-hidden", () => {
    const { home, cwd } = fixture();
    const rows = paneCommands("claude", cwd, home);
    for (const name of ["config", "usage", "cost", "status", "help", "add-dir", "mcp"]) expect(rows.find((row) => row.name === name)?.visibility).toBe("terminal");
    for (const name of ["fast", "export", "context", "plan"]) expect(rows.find((row) => row.name === name)?.visibility).toBe("offered");
    expect(rows.find((row) => row.name === "heapdump")?.visibility).toBe("agent-hidden");
    expect(rows.find((row) => row.name === "compact")?.visibility).toBe("offered");
  });

  it("shows one compact row, marked as shadowing the builtin, when a skill has that name", () => {
    const { home, cwd } = fixture();
    skill(join(cwd, ".claude/skills"), "compact");
    const rows = paneCommands("claude", cwd, home).filter((row) => row.name === "compact");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.shadows).toBe("builtin");
    expect(rows[0]?.source).toBe("skill");
  });
});

describe("Claude skill identity", () => {
  it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const { home, repo, cwd } = fixture();
    skill(join(home, ".claude/skills"), "aliased", "description: Aliased");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    symlinkSync(join(home, ".claude/skills"), join(repo, ".claude/skills"), "dir");
    const rows = paneCommands("claude", cwd, home).filter(({ name }) => name === "aliased");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", origin: "user", id: real(join(home, ".claude/skills/aliased/SKILL.md")) });
  });
});
