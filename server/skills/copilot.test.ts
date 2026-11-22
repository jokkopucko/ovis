import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalCommand } from "../../src/lib/compose.ts";
import { paneCommands } from "../commands.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "copilot-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
function skill(directory: string, name: string, fields = ""): void {
  put(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} from ${directory}\n${fields}---\nBody\n`);
}
const skills = (cwd: string | null, home: string, env: string[] | null = null) =>
  paneCommands("copilot", cwd, home, { environ: env }).filter(({ source }) => source === "skill");

it("lists the rows of Copilot 1.0.105's own menu, with its typed-only aliases hidden", () => {
  const commands = paneCommands("copilot", null, temp());
  const builtins = commands.filter(({ source }) => source === "builtin");
  expect(builtins.filter(({ visibility }) => visibility !== "agent-hidden")).toHaveLength(71);
  expect(builtins.filter(({ visibility }) => visibility === "agent-hidden").map(({ name }) => name).sort()).toEqual(["footer", "rewind", "rubber-duck"]);
  expect(builtins.find(({ name }) => name === "undo")).toMatchObject({ description: "Rewind the last turn and revert file changes", provenance: { transport: "static" } });
});

it("puts only the forms that leave a Copilot screen waiting for a key under Terminal commands", () => {
  const byName = new Map(paneCommands("copilot", null, temp()).map((command) => [command.name, command]));
  for (const name of ["model", "resume", "skills", "settings", "diff", "login"]) expect(terminalCommand(byName.get(name)!), name).toBeTrue();
  for (const name of ["usage", "context", "new", "clear", "copy", "version", "compact"]) expect(terminalCommand(byName.get(name)!), name).toBeFalse();
  expect(byName.get("model")!.forms).toEqual([{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }]);
});

it("reads skills in Copilot's order: nearest project folder first, then personal, then added folders", () => {
  const home = temp(), repo = join(home, "repo"), cwd = join(repo, "sub");
  put(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  skill(join(cwd, ".github", "skills", "up"), "shared");
  skill(join(repo, ".github", "skills", "down"), "shared");
  skill(join(repo, ".agents", "skills", "a"), "folder-order");
  skill(join(repo, ".claude", "skills", "c"), "folder-order");
  skill(join(repo, ".github", "skills", "deep", "er", "nested"), "nested");
  skill(join(home, ".copilot", "skills", "p"), "personal");
  skill(join(home, ".agents", "skills", "p"), "personal");
  skill(join(home, ".agents", "skills", "agents-only"), "agents-only");
  skill(join(home, ".claude", "skills", "not-read"), "not-read");
  skill(join(home, "added", "x"), "added");
  put(join(home, ".copilot", "settings.json"), `// managed\n{ "skillDirectories": ["${join(home, "added")}"] }\n`);
  const found = skills(cwd, home);
  expect(found.map(({ name, origin }) => [name, origin])).toEqual([
    ["added", "user"], ["agents-only", "user"], ["folder-order", "project"], ["nested", "project"], ["personal", "user"], ["shared", "project"],
  ]);
  expect(found.find(({ name }) => name === "shared")!.id).toBe(join(cwd, ".github", "skills", "up", "SKILL.md"));
  expect(found.find(({ name }) => name === "folder-order")!.id).toBe(join(repo, ".agents", "skills", "a", "SKILL.md"));
  expect(found.find(({ name }) => name === "personal")!.id).toBe(join(home, ".copilot", "skills", "p", "SKILL.md"));
});

it("walks up to the home folder outside a repository, as Copilot does", () => {
  const root = temp(), home = join(root, "home"), cwd = join(home, "project", "sub");
  mkdirSync(cwd, { recursive: true });
  skill(join(home, "project", ".claude", "skills", "near"), "near");
  skill(join(home, ".github", "skills", "at-home"), "at-home");
  skill(join(root, ".github", "skills", "above-home"), "above-home");
  expect(skills(cwd, home).map(({ name, origin }) => [name, origin])).toEqual([["at-home", "project"], ["near", "project"]]);
});

it("reads names and folders the way Copilot does, and keeps the list when one root is a file", () => {
  const home = temp(), cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  put(join(home, ".copilot", "skills"), "not a folder");
  skill(join(cwd, "relative", "pane-folder"), "pane-folder");
  skill(join(home, ".agents", "skills", "dotted"), "dotted.name");
  put(join(home, ".agents", "skills", "no-header", "SKILL.md"), "Just a body\n");
  put(join(home, ".copilot", "settings.json"), '{ "skillDirectories": ["relative"] }');
  expect(skills(cwd, home, null).map(({ name }) => name)).toEqual(["dotted.name", "pane-folder"]);
  expect(paneCommands("copilot", cwd, home).some(({ name }) => name === "model")).toBeTrue();
});

it("follows COPILOT_HOME and leaves out what Copilot's menu leaves out", () => {
  const home = temp(), copilotHome = join(home, "elsewhere");
  skill(join(copilotHome, "skills", "kept"), "kept");
  skill(join(copilotHome, "skills", "off"), "off");
  skill(join(copilotHome, "skills", "model-only"), "model-only", "user-invocable: false\n");
  skill(join(copilotHome, "skills", "help"), "help");
  skill(join(home, ".copilot", "skills", "default-home"), "default-home");
  put(join(copilotHome, "settings.json"), '{ "disabledSkills": ["off"] }');
  expect(skills(null, home, [`COPILOT_HOME=${copilotHome}`]).map(({ name }) => name)).toEqual(["kept"]);
  // the builtin /help keeps its row: Copilot runs it, not the skill
  expect(paneCommands("copilot", null, home, { environ: [`COPILOT_HOME=${copilotHome}`] }).filter(({ name }) => name === "help").map(({ source }) => source)).toEqual(["builtin"]);
});
