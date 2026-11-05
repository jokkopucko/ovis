import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";
import { source } from "./pi.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import { typedTerminalCommand } from "../../src/lib/compose.ts";

const roots: string[] = [];
const previousHome = process.env.HOME;
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const skill = (root: string, name: string, description = `${name} skill`) => put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
const scan = (home: string, cwd: string | null) => source.discover({ home, cwd, repoRoot: null, env: null, roots: {} }).sort((left, right) => left.name.localeCompare(right.name));
const extra = (home: string, cwd: string | null) => scan(home, cwd);
const names = (home: string, cwd: string | null) => extra(home, cwd).map((command) => command.name);

/** a home, and a project that is a repository with a pane working in a subfolder of it */
function setup(): { home: string; repo: string; cwd: string; agentDir: string } {
  const home = temp();
  process.env.HOME = home;
  const repo = join(temp(), "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const cwd = join(repo, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  return { home, repo, cwd, agentDir: join(home, ".pi", "agent") };
}

describe("pi's builtins", () => {
  it("matches the pinned builtin names and descriptions", () => {
    const upstream = [
      ["settings", "Open settings menu"],
      ["model", "Select model (opens selector UI)"],
      ["tree", "Navigate session tree (switch branches)"],
      ["thinking", "Set thinking level"],
      ["scoped-models", "Enable/disable models for Ctrl+P cycling"],
      ["export", "Export session (HTML default, or specify path: .html/.jsonl)"],
      ["import", "Import and resume a session from a JSONL file"],
      ["share", "Share session via a Radius artifact or a GitHub gist"],
      ["bug", "Report a bug to the Pi developers"],
      ["copy", "Copy last agent message to clipboard"],
      ["name", "Set session display name"],
      ["session", "Show session info and stats"],
      ["changelog", "Show changelog entries"],
      ["hotkeys", "Show all keyboard shortcuts"],
      ["fork", "Create a new fork from a previous user message"],
      ["clone", "Duplicate the current session at the current position"],
      ["trust", "Save project trust decision for future sessions"],
      ["login", "Configure provider authentication"],
      ["logout", "Remove provider authentication"],
      ["new", "Start a new session"],
      ["compact", "Manually compact the session context"],
      ["resume", "Resume a different session"],
      ["reload", "Reload keybindings, extensions, skills, prompts, themes, and context files"],
      ["quit", "Quit pi"],
    ] as const;
    const shown = source.builtins.filter((name) => !source.agentHidden?.includes(name));
    expect(shown).toEqual(upstream.map(([name]) => name));
    expect(Object.fromEntries(shown.map((name) => [name, source.descriptions?.[name]]))).toEqual(Object.fromEntries(upstream));
  });

  it("lists the builtins Pi runs itself but hides from its menu", () => {
    // Pi 1.4's submit handler runs these when typed exactly; they never reach the transcript
    expect(source.agentHidden).toEqual(["debug", "arminsayshi", "dementedelves"]);
    for (const name of source.agentHidden ?? []) {
      expect(source.builtins).toContain(name);
      expect(source.forms?.[name]).toEqual([{ match: "bare", interaction: "terminal" }]);
    }
  });

  it("defines the canonical 24 builtins and the 3 hidden ones with forms, including terminal tree", () => {
    expect(source.builtins).toEqual([
      "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
      "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
      "compact", "resume", "reload", "quit", "debug", "arminsayshi", "dementedelves",
    ]);
    expect(source.terminalBound).toEqual(["tree"]);
    expect(source.forms?.["tree"]).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.["model"]).toEqual([
      { match: "bare", interaction: "dialog", dialog: "pi-model" },
      { match: "other", interaction: "none" },
    ]);
    expect(source.forms?.["thinking"]).toEqual([
      { match: "bare", interaction: "dialog", dialog: "pi-thinking" },
      { match: "other", interaction: "none" },
    ]);
  });

  it("keeps bare logout terminal-bound when OAuth credentials can open its selector", () => {
    expect(source.forms?.["logout"]?.[0]).toEqual({ match: "bare", interaction: "terminal" });
  });

  it("uses the canonical share description from pi's builtin command table", () => {
    expect(source.descriptions?.["share"]).toBe("Share session via a Radius artifact or a GitHub gist");
  });

  it("marks bare share, bug, copy and name output terminal when it is not persisted", () => {
    for (const name of ["share", "bug", "copy", "name"]) {
      expect(source.forms?.[name]?.[0]).toEqual({ match: "bare", interaction: "terminal" });
    }
    expect(source.forms?.["bug"]?.[1]).toEqual({ match: "other", interaction: "terminal" });
    expect(source.forms?.["name"]?.[1]).toEqual({ match: "other", interaction: "none" });
  });

  it("keeps reload and quit terminal because neither leaves bridge-readable result evidence", () => {
    expect(source.forms?.["reload"]).toEqual([{ match: "bare", interaction: "terminal" }]);
    expect(source.forms?.["quit"]).toEqual([{ match: "bare", interaction: "terminal" }]);
  });

  it("keeps new and clone unknown until an empty session has a persisted conversation", () => {
    expect(source.forms?.["new"]).toEqual([{ match: "bare", interaction: "unknown" }]);
    expect(source.forms?.["clone"]).toEqual([{ match: "bare", interaction: "unknown" }]);
  });

  it("limits none forms to effects recorded in the session or persisted state", () => {
    const noneForms = Object.fromEntries(Object.entries(source.forms ?? {})
      .map(([name, forms]) => [name, (forms ?? []).filter((form) => form.interaction === "none")] as const)
      .filter(([, forms]) => forms.length > 0));
    expect(noneForms).toEqual({
      model: [{ match: "other", interaction: "none" }],
      thinking: [{ match: "other", interaction: "none" }],
      compact: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }],
      name: [{ match: "other", interaction: "none" }],
    });
  });

  it("pins builtins to Pi 1.3 and verifies only a matching major-minor version", () => {
    expect(source.pin).toBe("1.3.0");
    expect(paneCommands("pi", null, temp(), {}, "1.3.9").filter((row) => row.source === "builtin").every((row) => row.provenance?.verified)).toBeTrue();
    expect(paneCommands("pi", null, temp(), {}, "1.4.0").filter((row) => row.source === "builtin").some((row) => row.provenance?.verified)).toBeFalse();
  });

  it("compiles the scanner forms and terminal-bound names into catalog rows", () => {
    const rows = paneCommands("pi", null, temp());
    expect(rows.find(({ name }) => name === "tree")).toMatchObject({
      visibility: "terminal",
      forms: [{ match: "bare", interaction: "terminal" }],
    });
    expect(rows.find(({ name }) => name === "model")?.forms).toEqual(source.forms?.["model"]);
  });
});

describe("pi's user skills", () => {
  it("lists a nested skill from the agent dir and ~/.agents, as the person's own", () => {
    const { home, agentDir } = setup();
    skill(join(agentDir, "skills", "group", "inner"), "deep-one");
    skill(join(home, ".agents", "skills"), "shared");
    put(join(agentDir, "skills", "loose.md"), "---\nname: loose\ndescription: A loose root file\n---\n");
    put(join(agentDir, "skills", "group", "ignored.md"), "---\nname: nested-loose\ndescription: Not at the root\n---\n");
    expect(extra(home, null)).toMatchObject([
      { name: "skill:deep-one", description: "deep-one skill", source: "skill", origin: "user" },
      { name: "skill:loose", description: "A loose root file", source: "skill", origin: "user" },
      { name: "skill:shared", description: "shared skill", source: "skill", origin: "user" },
    ]);
  });

  it("skips a skill with no description, which pi does not load", () => {
    const { home, agentDir } = setup();
    put(join(agentDir, "skills", "bare", "SKILL.md"), "---\nname: bare\n---\nbody\n");
    expect(names(home, null)).toEqual([]);
  });

  it("takes the agent dir from the pane's environ", () => {
    const { home } = setup();
    const other = temp();
    skill(join(other, "skills"), "elsewhere");
    const commands = source.discover({ home, cwd: null, repoRoot: null, env: [`PI_CODING_AGENT_DIR=${other}`], roots: {} });
    expect(commands.map((command) => command.name)).toEqual(["skill:elsewhere"]);
  });
});

describe("pi's settings skills", () => {
  it("adds paths from the agent dir, and honours -path, !glob and +path", () => {
    const { home, agentDir } = setup();
    skill(join(agentDir, "skills"), "off-by-path");
    skill(join(agentDir, "skills"), "off-by-glob");
    skill(join(agentDir, "skills"), "stays");
    skill(join(agentDir, "extra", "pack"), "listed");
    skill(join(agentDir, "extra", "pack"), "dropped");
    skill(join(agentDir, "forced"), "forced-in");
    put(join(agentDir, "single.md"), "---\ndescription: One file\n---\n");
    put(join(agentDir, "settings.json"), JSON.stringify({ skills: ["extra/pack", "single.md", "-skills/off-by-path", "!skills/off-by-glob/**", "!extra/pack/dropped/*", "+forced"] }));
    expect(names(home, null).sort()).toEqual(["skill:forced-in", "skill:listed", "skill:single", "skill:stays"]);
  });
});

describe("pi's project skills and prompts", () => {
  function plant(repo: string, cwd: string): void {
    skill(join(repo, ".pi", "skills"), "repo-skill");
    skill(join(repo, "packages", ".agents", "skills"), "agents-skill");
    put(join(cwd, ".pi", "prompts", "ship.md"), "---\ndescription: Ship it\n---\n");
  }

  it("lists none without a trust decision", () => {
    const { home, repo, cwd } = setup();
    plant(repo, cwd);
    expect(names(home, cwd)).toEqual([]);
  });

  it("lists them, from every ancestor to the repo root, once trust.json lists the repo", () => {
    const { home, repo, cwd, agentDir } = setup();
    plant(repo, cwd);
    put(join(agentDir, "trust.json"), JSON.stringify({ [repo]: true }));
    expect(extra(home, cwd)).toMatchObject([
      { name: "ship", description: "Ship it", source: "project" },
      { name: "skill:agents-skill", description: "agents-skill skill", source: "skill", origin: "project" },
      { name: "skill:repo-skill", description: "repo-skill skill", source: "skill", origin: "project" },
    ]);
  });

  it("lists them under defaultProjectTrust always, and a closer refusal wins over it", () => {
    const { home, repo, cwd, agentDir } = setup();
    plant(repo, cwd);
    put(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    expect(names(home, cwd)).toEqual(["ship", "skill:agents-skill", "skill:repo-skill"]);
    put(join(agentDir, "trust.json"), JSON.stringify({ [repo]: false }));
    expect(names(home, cwd)).toEqual([]);
  });
});

describe("pi skill identity", () => {
  it("lists a skill reached through a symlinked alias root once, identified by its real file", () => {
    const { home, agentDir } = setup();
    delete process.env["PI_CODING_AGENT_DIR"];
    skill(join(agentDir, "skills"), "aliased");
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(join(agentDir, "skills"), join(home, ".agents", "skills"), "dir");
    const rows = paneCommands("pi", null, home).filter(({ name }) => name === "skill:aliased");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "skill", origin: "user", id: realpathSync(join(agentDir, "skills", "aliased", "SKILL.md")) });
  });

  it("identifies a skill a settings entry names through a link by its real file", () => {
    const { home, agentDir } = setup();
    delete process.env["PI_CODING_AGENT_DIR"];
    skill(join(agentDir, "skills"), "entry");
    symlinkSync(join(agentDir, "skills"), join(home, "linked"), "dir");
    put(join(agentDir, "settings.json"), JSON.stringify({ skills: [join(home, "linked", "entry", "SKILL.md")] }));
    const rows = paneCommands("pi", null, home).filter(({ name }) => name === "skill:entry");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: realpathSync(join(agentDir, "skills", "entry", "SKILL.md")) });
  });
});

describe("pi's forms as the chat reads them", () => {
  it("tells pi's bare commands from the ones given an argument", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-forms-"));
    let rows: SlashCommand[];
    try { rows = JSON.parse(JSON.stringify(paneCommands("pi", null, home))) as SlashCommand[]; }
    finally { rmSync(home, { recursive: true, force: true }); }
    // bare /name shows the name in the terminal; with an argument it only sets it, like /model <id>
    expect(typedTerminalCommand(rows, "/name")?.name).toBe("name");
    expect(typedTerminalCommand(rows, "/name Release 1")).toBeNull();
    expect(typedTerminalCommand(rows, "/model anthropic/fictional-model")).toBeNull();
    expect(typedTerminalCommand(rows, "/export out.html")?.name).toBe("export");
  });
});
