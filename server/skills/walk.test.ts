import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { userHome } from "../user-home.ts";
import { ancestorsToRepoRoot, createWalkBudget, customCommands, customCommandSteps, readFrontmatter, walkSkills, walkSkillSteps } from "./walk.ts";
import { source as claude } from "./claude.ts";
import { source as devin } from "./devin.ts";
import type { WalkRules } from "./walk.ts";

const roots: string[] = [];
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-walk-"));
  roots.push(root);
  return root;
}
function put(path: string, content = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const recursive: WalkRules = { depth: "recursive", looseMarkdown: "root", ignoreFiles: true, requireDescription: true };
const one: WalkRules = { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: false };

function lattice(root: string): void {
  for (let level = 0; level < 8; level++) {
    const directory = join(root, String(level));
    for (let entry = 0; entry < 20; entry++) put(join(directory, `file-${entry}.md`), "Body\n");
    if (level < 7) for (let link = 0; link < 3; link++) {
      symlinkSync(join(root, String(level + 1)), join(directory, `link-${link}`), "dir");
    }
  }
}

describe("shared skill walk", () => {
  for (const kind of ["skills", "commands", "one-level"] as const) {
    for (const exhausted of ["folders", "entries", "reads"] as const) {
      it(`does no resumed directory work in ${kind} after ${exhausted} is exhausted`, () => {
        const root = temp();
        put(join(root, "file.md"), "Body");
        const budget = { folders: 16, entries: 16, reads: 16 };
        const walk = kind === "commands" ? customCommandSteps(root, "skill", budget)
          : walkSkillSteps(root, { ...recursive, depth: kind === "one-level" ? "one" : "recursive", ignoreFiles: false, budget });
        walk.next();
        budget[exhausted] = 0;
        const canonical = spyOn(fs, "realpathSync");
        const reads = spyOn(fs, "readdirSync");
        try {
          walk.next();
          expect(canonical).not.toHaveBeenCalled();
          expect(reads).not.toHaveBeenCalled();
        } finally { walk.return(undefined); canonical.mockRestore(); reads.mockRestore(); }
      });
    }
  }

  it("charges a skill directory once when sibling aliases cannot change its rows", () => {
    const root = temp();
    const directory = join(root, "original");
    put(join(directory, "SKILL.md"), "---\nname: declared\ndescription: Present\n---\n");
    symlinkSync(directory, join(root, "first"), "dir");
    symlinkSync(directory, join(root, "second"), "dir");
    const budget = { folders: 32, entries: 32, reads: 8 };
    const rows = walkSkills(root, { ...recursive, ignoreFiles: false, uniqueFolders: true, budget });
    expect(rows.map(({ name }) => name)).toEqual(["declared"]);
    expect(budget.reads).toBe(7);
  });

  it("preserves directory fallback names for nameless skill aliases", () => {
    const root = temp();
    const directory = join(root, "original");
    put(join(directory, "SKILL.md"), "---\ndescription: Present\n---\n");
    symlinkSync(directory, join(root, "first"), "dir");
    symlinkSync(directory, join(root, "second"), "dir");
    const rows = walkSkills(root, { ...recursive, ignoreFiles: false, uniqueFolders: true });
    expect(rows.map(({ name }) => name).sort()).toEqual(["first", "original", "second"]);
  });

  for (const kind of ["skills", "commands", "one-level"] as const) {
    it(`bounds entry work in ${kind} even when linked folders repeat`, () => {
      const root = temp();
      lattice(root);
      if (kind === "one-level") for (let entry = 0; entry < 200; entry++) put(join(root, `plain-${entry}`));
      const budget = { folders: 4096, entries: 128, reads: 1024 };
      const stats = spyOn(fs, "statSync");
      try {
        if (kind === "commands") customCommands(root, "skill", budget);
        else walkSkills(root, { ...recursive, depth: kind === "one-level" ? "one" : "recursive", ignoreFiles: false, budget });
        expect(stats.mock.calls.length).toBeLessThanOrEqual(128 + 1024 - budget.reads);
        expect(budget.entries).toBeLessThan(128);
      } finally { stats.mockRestore(); }
    });
  }

  for (const kind of ["skills", "commands"] as const) {
    it(`bounds file reads in ${kind} independently of entries`, () => {
      const root = temp();
      lattice(root);
      const budget = { folders: 4096, entries: 32768, reads: 16 };
      const opens = spyOn(fs, "openSync");
      try {
        if (kind === "commands") customCommands(root, "skill", budget);
        else walkSkills(root, { ...recursive, looseMarkdown: "nested", requireDescription: false, ignoreFiles: false, budget });
        expect(opens.mock.calls.length).toBeGreaterThan(0);
        expect(opens.mock.calls.length).toBeLessThanOrEqual(16);
      } finally { opens.mockRestore(); }
    });
  }

  for (const [agent, source] of [["claude", claude], ["devin", devin]] as const) {
    it(`shares the read allowance across ${agent} discovery roots`, () => {
      const home = temp();
      const project = join(home, "repo");
      put(join(project, ".git"), "");
      lattice(join(home, ".claude", "commands"));
      lattice(join(project, ".claude", "commands"));
      lattice(join(home, ".claude", "skills"));
      lattice(join(project, ".claude", "skills"));
      for (const base of [home, project]) {
        put(join(base, ".claude", "skills", "7", "SKILL.md"), "---\ndescription: Leaf\n---\nBody\n");
      }
      const opens = spyOn(fs, "openSync");
      try {
        source.discover({ home, cwd: project, repoRoot: project, env: null, roots: {} });
        expect(opens.mock.calls.length).toBeGreaterThan(0);
        expect(opens.mock.calls.length).toBeLessThanOrEqual(createWalkBudget().reads);
      } finally { opens.mockRestore(); }
    });
  }

  for (const count of [300, 1500]) {
    for (const requireDescription of [true, false]) {
      it(`lists all ${count} ordinary skills with requireDescription=${requireDescription}`, () => {
        const root = temp();
        const names = Array.from({ length: count }, (_, index) => `skill-${String(index).padStart(4, "0")}`);
        for (const name of names) put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Present\n---\nBody\n`);
        const rows = walkSkills(root, { ...recursive, requireDescription });
        expect(rows.map(({ name }) => name).sort()).toEqual(names);
      });
    }
  }

  for (const [agent, source] of [["claude", claude], ["devin", devin]] as const) {
    for (const count of [513, 1024, 4097]) {
      it(`retains an ordered command prefix for ${agent} with ${count} files`, () => {
        const home = temp();
        const project = join(home, "repo");
        const commands = join(project, ".claude", "commands");
        put(join(project, ".git"));
        for (let index = 0; index < count; index++) {
          const hidden = index === 1 || index === 4095;
          put(join(commands, `task-${String(index).padStart(4, "0")}.md`),
            `---\nuser-invocable: ${!hidden}\ntriggers: [${hidden ? "model" : "user"}]\n---\nBody\n`);
        }
        const expected = fs.readdirSync(commands).slice(0, createWalkBudget().reads)
          .filter((name) => name !== "task-0001.md" && name !== "task-4095.md").map((name) => name.slice(0, -3));
        const opens = spyOn(fs, "openSync");
        try {
          const rows = source.discover({ home, cwd: project, repoRoot: project, env: null, roots: {} });
          expect(rows.filter(({ source }) => source !== "builtin").map(({ name }) => name)).toEqual(expected);
          expect(opens.mock.calls.length).toBeLessThanOrEqual(createWalkBudget().reads);
        } finally { opens.mockRestore(); }
      });
    }
  }

  it("keeps one-level names, whole descriptions, and body fallbacks", () => {
    const root = temp();
    put(join(root, "named", "SKILL.md"), `---\nname: valid:name\ndescription: ${"x".repeat(150)}\n---\n`);
    put(join(root, "fallback", "SKILL.md"), "---\nname: invalid name\n---\nBody fallback\n");
    put(join(root, "group", "deep", "SKILL.md"), "---\ndescription: Deep\n---\n");
    put(join(root, "loose.md"), "---\ndescription: Loose\n---\n");
    expect(walkSkills(root, one).map(({ name, description }) => [name, description]).sort()).toEqual([
      ["fallback", "Body fallback"], ["valid:name", "x".repeat(150)],
    ]);
  });

  it("uses the name from a BOM-prefixed one-level skill header", () => {
    const root = temp();
    put(join(root, "folder", "SKILL.md"), "\uFEFF---\r\nname: declared\r\ndescription: Present\r\n---\r\n");
    expect(walkSkills(root, one).map(({ name }) => name)).toEqual(["declared"]);
  });

  it("distinguishes root and nested loose markdown and stops at declared skills", () => {
    const root = temp();
    put(join(root, "root.md"), "---\nname: root\ndescription: Root\n---\n");
    put(join(root, "group", "inner.md"), "---\nname: nested\ndescription: Nested\n---\n");
    put(join(root, "declared", "SKILL.md"), "---\nname: declared\ndescription: Declared\n---\n");
    put(join(root, "declared", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: Hidden\n---\n");
    expect(walkSkills(root, recursive).map(({ name }) => name).sort()).toEqual(["declared", "root"]);
    expect(walkSkills(root, { ...recursive, looseMarkdown: "nested" }).map(({ name }) => name).sort()).toEqual(["declared", "nested"]);
    expect(walkSkills(root, { ...recursive, looseMarkdown: "none" }).map(({ name }) => name)).toEqual(["declared"]);
  });

  it("honors ignores, skip names, symlinks, and the description requirement", () => {
    const root = temp();
    for (const name of ["keep", "ignored", "skipped", ".hidden", "node_modules"]) {
      put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Present\n---\n`);
    }
    put(join(root, "blank", "SKILL.md"), '---\ndescription: " "\n---\n');
    put(join(root, "missing", "SKILL.md"), "---\nname: missing\n---\nBody\n");
    put(join(root, ".ignore"), "ignored/\n");
    symlinkSync(".", join(root, "cycle"), "dir");
    symlinkSync("absent", join(root, "broken"), "dir");
    expect(walkSkills(root, { ...recursive, skipNames: (name) => name === "skipped" }).map(({ name }) => name)).toEqual(["keep"]);
    expect(walkSkills(root, { ...one, skipNames: (name) => name === "skipped" }).some(({ name }) => name === "ignored")).toBeTrue();
  });

  it("reads complete UTF-8 YAML metadata and rejects malformed frontmatter", () => {
    const root = temp();
    const path = join(root, "SKILL.md");
    const description = "한".repeat(3000);
    put(path, `\uFEFF---\r\nname: full\r\ndescription: ${description}\r\nuser-invocable: false\r\n---\r\nBody\n`);
    expect(readFrontmatter(path)).toEqual({ name: "full", description, "user-invocable": false });
    put(join(root, "bad.md"), "---\ndescription: [\n---\n");
    expect(readFrontmatter(join(root, "bad.md"))).toBeNull();
    expect(readFrontmatter(join(root, "absent.md"))).toBeNull();
  });

  it("reads a bounded prefix of regular files only, so a huge or device skill cannot stall discovery", () => {
    const root = temp();
    put(join(root, "huge", "SKILL.md"), `---\ndescription: huge\n${"x: y\n".repeat(100_000)}---\nbody`);
    put(join(root, "small", "SKILL.md"), "---\ndescription: small\n---\nbody");
    if (process.platform !== "win32") {
      mkdirSync(join(root, "device"));
      symlinkSync("/dev/zero", join(root, "device", "SKILL.md"));
      expect(readFrontmatter(join(root, "device", "SKILL.md"))).toBeNull();
    }
    expect(readFrontmatter(join(root, "huge", "SKILL.md"))).toBeNull();
    expect(walkSkills(root, { ...one, requireDescription: true }).map((skill) => skill.name)).toEqual(["small"]);
    expect(walkSkills(root, one).map((skill) => skill.name).sort()).toEqual(["huge", "small"]);
  });

  it("leaves empty homes at builtins and unimplemented sources empty", () => {
    const home = temp();
    for (const agent of ["omo", "claude", "codex", "pi", "omp", "grok", "agy", "devin", "hermes"]) {
      expect(paneCommands(agent, home, home).every(({ source }) => source === "builtin")).toBeTrue();
    }
    const opencode = paneCommands("opencode", home, home);
    expect(opencode.filter(({ source }) => source === "builtin").map(({ name }) => name)).toEqual([
      "agents", "compact", "connect", "copy", "debug", "diff", "editor", "exit", "export", "fork", "help", "init", "mcps", "models", "move",
      "new", "org", "redo", "rename", "review", "sessions", "skills", "status", "themes", "thinking", "timeline", "timestamps", "undo",
      "update", "variants", "warp", "workspaces",
    ]);
    expect(opencode.filter(({ source }) => source !== "builtin").map(({ name, source, origin }) => ({ name, source, origin }))).toEqual([
      { name: "customize-opencode", source: "skill", origin: "bundled" },
    ]);
  });
});

describe("repository ancestors", () => {
  for (const kind of ["file", "directory"]) {
    it(`stops at the nearest .git ${kind}`, () => {
      const home = temp();
      process.env.HOME = home;
      const repo = join(home, "repo");
      const cwd = join(repo, "sub", "deep");
      mkdirSync(cwd, { recursive: true });
      if (kind === "file") put(join(repo, ".git"), "gitdir: /fixture");
      else mkdirSync(join(repo, ".git"));
      expect(ancestorsToRepoRoot(cwd)).toEqual([cwd, join(repo, "sub"), repo]);
    });
  }
  it("never includes home or its repository and falls back to cwd without a boundary", () => {
    const home = temp();
    process.env.HOME = home;
    const cwd = join(home, "sub", "deep");
    mkdirSync(cwd, { recursive: true });
    put(join(home, ".git"), "gitdir: /fixture");
    expect(ancestorsToRepoRoot(cwd)).toEqual([cwd]);
    expect(ancestorsToRepoRoot(home)).toEqual([]);
    expect(ancestorsToRepoRoot(join(home, ".."))).toEqual([]);
  });

  it("finds the user's home without HOME, as native Windows starts it", () => {
    // a HOME set for Git or Emacs is not where the agents keep their stores: they ask Windows
    expect(userHome({ HOME: "/home/user", USERPROFILE: "C:\\Users\\user" }, "win32")).toBe("C:\\Users\\user");
    expect(userHome({ HOME: "/home/user" }, "win32")).toBe("/home/user");
    expect(userHome({ HOME: "", USERPROFILE: "C:\\Users\\user" }, "win32")).toBe("C:\\Users\\user");
    expect(userHome({}, "win32")).toBe(homedir());
    expect(userHome({}, "linux")).toBe("");
    // USERPROFILE is Windows' alone: a missing HOME elsewhere is not filled from it
    expect(userHome({ HOME: "", USERPROFILE: "/profile" }, "linux")).toBe("");
  });

  it("falls back to USERPROFILE when HOME is unset on Windows", () => {
    const home = temp();
    delete process.env.HOME;
    process.env.USERPROFILE = home;
    const repo = join(home, "repo");
    const cwd = join(repo, "sub");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(repo, ".git"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(ancestorsToRepoRoot(cwd)).toEqual([cwd, repo]);
      expect(ancestorsToRepoRoot(home)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("meets a home in another letter case on Windows, from below it and from above it", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    const home = join(root, "Home");
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    expect(ancestorsToRepoRoot(cwd, home.toUpperCase(), "win32")).toEqual([cwd]);
    expect(ancestorsToRepoRoot(root, home.toUpperCase(), "win32")).toEqual([]);
    expect(ancestorsToRepoRoot(root.toUpperCase(), home, "win32")).toEqual([]);
    // elsewhere letter case tells folders apart
    expect(ancestorsToRepoRoot(cwd, home.toUpperCase(), "linux")).toEqual([cwd, home, root]);
    expect(ancestorsToRepoRoot(root, home.toUpperCase(), "linux")).toEqual([root]);
  });

});
