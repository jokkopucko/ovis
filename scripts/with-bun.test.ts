import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(import.meta.dir, "with-bun.sh");
const preflight = join(import.meta.dir, "preflight.sh");

describe.skipIf(process.platform === "win32")("Unix Bun discovery", () => {
  // A PATH with the three tools the scripts call and nothing else, so a bun or node installed on
  // this PC (in /usr/bin, say) can neither satisfy a case nor break one.
  let base: string, home: string, tools: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "with-bun-"));
    home = join(base, "home");
    tools = join(base, "tools");
    mkdirSync(home);
    mkdirSync(tools);
    for (const name of ["sh", "sed", "dirname"]) symlinkSync(Bun.which(name)!, join(tools, name));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function tool(dir: string, name: string, version: string) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; else printf '%s\\n' "$@"; fi\n`);
    chmodSync(file, 0o755);
  }

  async function run(command: string[], overrides: Record<string, string | undefined> = {}) {
    const child = Bun.spawn(command, {
      cwd: root,
      env: { HOME: home, PATH: tools, ...overrides },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { out, err, code };
  }

  it("finds ~/.bun/bin and preserves argument boundaries with a bare PATH", async () => {
    tool(join(home, ".bun", "bin"), "bun", "1.4.2");
    const result = await run(["/bin/sh", script, "scripts/plugin.ts", "two words", ""]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("scripts/plugin.ts\ntwo words\n\n");
  });

  it("finds Bun in BUN_INSTALL when it is outside the default home", async () => {
    tool(join(home, "custom", "bin"), "bun", "1.4.2");
    const result = await run(["/bin/sh", script, "--version"], { BUN_INSTALL: join(home, "custom") });
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("1.4.2");
  });

  it("keeps the Bun already on PATH ahead of fallback locations", async () => {
    tool(join(home, "chosen"), "bun", "1.4.3");
    tool(join(home, ".bun", "bin"), "bun", "1.4.2");
    const result = await run(["/bin/sh", script, "--version"], { PATH: `${join(home, "chosen")}:${tools}` });
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("1.4.3");
  });

  it("lets the launched Bun discover Grok in ~/.local/bin with a service's bare PATH", async () => {
    const bin = join(home, ".bun", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    tool(join(home, ".local", "bin"), "grok", "fixture");
    const result = await run(["/bin/sh", script, "-e", 'console.log(Bun.which("grok"))']);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(join(home, ".local", "bin", "grok"));
  });

  it("keeps a Grok already on PATH ahead of the user-local fallback", async () => {
    const bin = join(home, ".bun", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    tool(tools, "grok", "chosen");
    tool(join(home, ".local", "bin"), "grok", "fallback");
    const result = await run(["/bin/sh", script, "-e", 'console.log(Bun.which("grok"))']);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(join(tools, "grok"));
  });

  it("exits 127 when Bun is missing from PATH and the configured locations", async () => {
    const result = await run(["/bin/sh", script, "x"], { WITH_BUN_EXTRA_DIRS: join(home, "missing") });
    expect(result.code).toBe(127);
    expect(result.out).toBe("");
    expect(result.err).toContain("bun not found");
  });

  it("finds Bun in a home directory whose name has a space, not in the directory before the space", async () => {
    const spaced = join(base, "alice smith");
    tool(join(spaced, ".bun", "bin"), "bun", "1.4.2");
    tool(join(base, "alice"), "bun", "9.9.9");
    const result = await run(["/bin/sh", script, "--version"], { HOME: spaced });
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("1.4.2");
  });

  async function searched(overrides: Record<string, string | undefined> = {}) {
    return (await run(["/bin/sh", "-c", `. "$1" && printf %s "$PATH"`, "sh", join(import.meta.dir, "bun-path.sh")], overrides)).out;
  }

  it("looks in the home directory's own places before a version manager's shims", async () => {
    const dirs = [join(home, ".bun", "bin"), join(home, ".local", "bin"), join(home, ".local", "share", "mise", "shims")];
    for (const dir of [...dirs].reverse()) mkdirSync(dir, { recursive: true });
    expect((await searched()).split(":").slice(0, 4)).toEqual([tools, ...dirs]);
  });

  it("takes only absolute directories from WITH_BUN_EXTRA_DIRS, without expanding a pattern", async () => {
    const dir = join(home, "with space");
    mkdirSync(dir);
    mkdirSync(join(home, "wide"));
    expect(await searched({ WITH_BUN_EXTRA_DIRS: `scripts::${home}/w*:${dir}` })).toBe(`${tools}:${dir}`);
  });

  it("preflight says what is missing when HOME is not set", async () => {
    const result = await run(["/bin/sh", preflight], { HOME: undefined, WITH_BUN_EXTRA_DIRS: undefined });
    expect(result.err).toBe("");
    expect(result.code).toBeLessThan(2);
  });

  it("preflight finds Bun and Node from extra locations with a bare PATH", async () => {
    const bunDir = join(home, ".bun", "bin"), nodeDir = join(home, "node");
    tool(bunDir, "bun", "1.4.2");
    tool(nodeDir, "node", "v22.0.0");
    const result = await run(["/bin/sh", preflight], { WITH_BUN_EXTRA_DIRS: `${bunDir}:${nodeDir}` });
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toBe("");
  });

  it.each(["0.9.0", "1.3.9", "1.4.0", "1.4.2", "2.0.0"])("keeps preflight's Bun version behavior for %s", async version => {
    const dir = join(home, ".bun", "bin");
    tool(dir, "bun", version);
    tool(dir, "node", "v22.0.0");
    const result = await run(["/bin/sh", preflight], { WITH_BUN_EXTRA_DIRS: dir });
    expect(result.code).toBe(version === "0.9.0" || version === "1.3.9" ? 1 : 0);
  });

  it("preflight names Homebrew's update for a too-old Homebrew Bun, and bun upgrade otherwise", async () => {
    const brewDir = join(home, "Cellar", "bun", "1.3.14", "bin"), plainDir = join(home, ".bun", "bin");
    tool(brewDir, "bun", "1.3.14");
    tool(brewDir, "node", "v22.0.0");
    tool(plainDir, "bun", "1.3.14");
    tool(plainDir, "node", "v22.0.0");
    const brew = await run(["/bin/sh", preflight], { WITH_BUN_EXTRA_DIRS: brewDir });
    expect(brew.code).toBe(1);
    expect(brew.out).toContain("Update it with: brew upgrade bun");
    const plain = await run(["/bin/sh", preflight], { WITH_BUN_EXTRA_DIRS: plainDir });
    expect(plain.code).toBe(1);
    expect(plain.out).toContain("Update it with: bun upgrade");
  });

  // a bin directory links into the Cellar, as Homebrew does, here through a second link
  it.each(["readlink", "ls"])("preflight follows links into Homebrew's Cellar with only %s to read them", async (reader) => {
    const cellar = join(home, "prefix", "Cellar", "bun", "1.3.14", "bin"), bin = join(home, "prefix", "bin"), outer = join(home, "outer");
    tool(cellar, "bun", "1.3.14");
    mkdirSync(bin);
    mkdirSync(outer);
    symlinkSync(join("..", "Cellar", "bun", "1.3.14", "bin", "bun"), join(bin, "bun"));
    symlinkSync(join(bin, "bun"), join(outer, "bun"));
    tool(outer, "node", "v22.0.0");
    const utils = join(base, "utils");
    mkdirSync(utils);
    symlinkSync(Bun.which(reader)!, join(utils, reader));
    const result = await run(["/bin/sh", preflight], { PATH: `${tools}:${utils}`, WITH_BUN_EXTRA_DIRS: outer });
    expect(result.code).toBe(1);
    expect(result.out).toContain("Update it with: brew upgrade bun");
  });

  it("preflight names Homebrew's update for a link into a Homebrew prefix that has no Cellar on the way", async () => {
    const prefix = join(home, "opt", "homebrew"), bin = join(prefix, "bin"), outer = join(home, "outer");
    tool(bin, "bun", "1.3.14");
    mkdirSync(outer);
    symlinkSync(join(bin, "bun"), join(outer, "bun"));
    tool(outer, "node", "v22.0.0");
    const utils = join(base, "utils");
    mkdirSync(utils);
    symlinkSync(Bun.which("readlink")!, join(utils, "readlink"));
    const env = { PATH: `${tools}:${utils}`, WITH_BUN_EXTRA_DIRS: outer };
    const brew = await run(["/bin/sh", preflight], { ...env, OVIS_TEST_BREW_PREFIXES: prefix });
    expect(brew.out).toContain("Update it with: brew upgrade bun");
    const other = await run(["/bin/sh", preflight], { ...env, OVIS_TEST_BREW_PREFIXES: join(home, "elsewhere") });
    expect(other.out).toContain("Update it with: bun upgrade");
  });

  it("routes each Unix Bun entry through the launcher without changing its arguments", async () => {
    const manifest: Record<string, { command: string[]; platforms?: string[] }[]> =
      Bun.TOML.parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8"));
    tool(join(home, ".bun", "bin"), "bun", "1.4.2");
    const commands = ["build", "startup", "actions", "panes"].flatMap(section =>
      manifest[section].filter(entry => entry.platforms?.includes("linux") && entry.command[1] !== "scripts/preflight.sh"
        && entry.command[0] !== "herdr").map(entry => entry.command));
    expect(commands).toEqual([
      ["sh", "scripts/with-bun.sh", "scripts/plugin-launch.ts", "install"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin-launch.ts", "start"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin-launch.ts", "start"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin-launch.ts", "stop"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin-launch.ts", "status"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin-launch.ts", "phone-setup"],
    ]);
    for (const command of commands) {
      const result = await run(command);
      expect(result.code).toBe(0);
      expect(result.out).toBe(command.slice(2).join("\n") + "\n");
    }
    expect(manifest.build.filter(entry => entry.platforms?.includes("windows")).map(entry => entry.command)).toEqual([
      ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "scripts/preflight.ps1"],
      ["bun", "scripts/plugin-launch.ts", "install"],
    ]);
  });
});
