import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CheckoutCommit, checkoutCommit, gitFailed, main, run } from "./plugin-launch.ts";
import { generateKeyPair, MANIFEST, releaseFile, PTY_ASSETS, ptyFile, SERVER_PLATFORMS, signManifest, sourceTrees, writeManifest } from "./server-manifest.ts";

const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
let scratch = "";
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-launch-"));
  saved = { OVIS_RELEASES_URL: process.env["OVIS_RELEASES_URL"], OVIS_FROM_SOURCE: process.env["OVIS_FROM_SOURCE"] };
  delete process.env["OVIS_FROM_SOURCE"];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const BUILT_FROM = { server: "a".repeat(40), shared: "b".repeat(40) };
async function launch(args: string[], fetchFile?: typeof fetch, sources: { server: string; shared: string } | { error: string } = BUILT_FROM): Promise<{ code: number; sourced: string[][]; home: string }> {
  const home = join(scratch, "server");
  const sourced: string[][] = [];
  const code = await main(args, { home, fetchFile, sources, source: async (command, rest) => { sourced.push([command, ...rest]); return 7; } });
  return { code, sourced, home };
}
function offline(asked: string[]): typeof fetch {
  return (async (url: string | URL | Request) => { asked.push(String(url)); throw new TypeError("fetch failed"); }) as typeof fetch;
}

describe("the herdr plugin's launcher", () => {
  it("runs the sources, saying so, when this version's release folder has no ovis-server.json, and a status remembers nothing", async () => {
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    mkdirSync(join(scratch, "release", `v${version}`), { recursive: true });
    const first = await launch(["status", "--json"]);
    expect(first).toMatchObject({ code: 7, sourced: [["status", "--json"]] });
    expect(existsSync(join(first.home, "from-source"))).toBe(false);
    expect(existsSync(join(first.home, "bin"))).toBe(false);
  });

  it("builds from source when GitHub answers 404 for this version's ovis-server.json", async () => {
    delete process.env["OVIS_RELEASES_URL"];
    const asked: string[] = [];
    const notFound = (async (url: string | URL | Request) => { asked.push(String(url)); return new Response(null, { status: 404 }); }) as typeof fetch;
    expect(await launch(["install"], notFound)).toMatchObject({ code: 7, sourced: [["install"]] });
    expect(asked).toEqual([`https://github.com/devswha/ovis/releases/download/v${version}/ovis-server.json`]);
  });

  it("fails, and never builds from source, on a server error", async () => {
    delete process.env["OVIS_RELEASES_URL"];
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const result = await launch(["start"], broken);
    expect(result).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(result.home, "from-source"))).toBe(false);
  });

  it("fails, and never builds from source, on a manifest that is there but not signed by the pinned key", async () => {
    const dir = join(scratch, "release", `v${version}`);
    mkdirSync(dir, { recursive: true });
    for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
    for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
    writeFileSync(join(dir, "ovis-dist.tar.gz"), "client\n");
    writeManifest(dir, { version, sources: BUILT_FROM });
    signManifest(dir, generateKeyPair().privateKeyPem);
    process.env["OVIS_RELEASES_URL"] = pathToFileURL(join(scratch, "release")).href;
    const result = await launch(["start"]);
    expect(result).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(result.home, "from-source"))).toBe(false);
    rmSync(join(dir, MANIFEST));
    expect((await launch(["status"])).sourced).toEqual([["status"]]);
  });

  it("asks the release again at the build step, so a release that gained its binary is taken", async () => {
    mkdirSync(join(scratch, "server"), { recursive: true });
    writeFileSync(join(scratch, "server", "from-source"), `${version}\n`);
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    expect(await launch(["install"])).toMatchObject({ code: 1, sourced: [] });
  });

  it("takes the source path at once with OVIS_FROM_SOURCE=1", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    process.env["OVIS_RELEASES_URL"] = "http://nowhere.invalid";
    expect(await launch(["phone-setup"])).toMatchObject({ code: 7, sourced: [["phone-setup"]] });
  });

  it("keeps the build step's source choice for every later command herdr runs without the variable", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const install = await launch(["install"]);
    expect(install).toMatchObject({ code: 7, sourced: [["install"]] });
    delete process.env["OVIS_FROM_SOURCE"];
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 7, sourced: [["start"]] });
  });

  it("ignores a source choice made for another version, and a build step without the variable drops it", async () => {
    const home = join(scratch, "server");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "from-source"), "0.0.1\n");
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 1, sourced: [] });
    writeFileSync(join(home, "from-source"), `${version}\n`);
    expect(await launch(["install"], broken)).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(home, "from-source"))).toBe(false);
  });

  const head = Bun.spawnSync(["git", "-C", join(import.meta.dir, ".."), "rev-parse", "HEAD"]).stdout.toString().trim();
  const finished = `${[version, head].filter(Boolean).join(" ")}\n`;
  async function build(exitCode: number, fetchFile?: typeof fetch): Promise<{ code: number; during: string; after: string }> {
    const home = join(scratch, "server");
    let during = "";
    const code = await main(["install"], { home, fetchFile, source: async () => { during = readFileSync(join(home, "source-build"), "utf8"); return exitCode; } });
    return { code, during, after: readFileSync(join(home, "source-build"), "utf8") };
  }

  it("stamps the build finished, with the version and the commit, only after every step returned 0", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    expect(await build(0)).toEqual({ code: 0, during: "started\n", after: finished });
    delete process.env["OVIS_FROM_SOURCE"];
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await build(0, notFound)).toEqual({ code: 0, during: "started\n", after: finished });
  });

  it("stamps the version alone in a folder git says is no repository", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    process.env["GIT_DIR"] = join(scratch, "no-git");
    try {
      expect(await checkoutCommit()).toEqual({ none: "no checkout" });
      expect(await build(0)).toEqual({ code: 0, during: "started\n", after: `${version}\n` });
    } finally {
      delete process.env["GIT_DIR"];
    }
  });

  it("leaves the build unfinished, saying git's words, where git fails at a checkout's top level", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    // git refusing a repository it takes for another user's, as for a folder another account owns (with no config of
    // this PC's that trusts every folder)
    const set = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: join(scratch, "no-config"), GIT_CONFIG_NOSYSTEM: "1" };
    const given = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
    Object.assign(process.env, set);
    try {
      expect(await checkoutCommit()).toMatchObject({ failed: expect.stringMatching(/^fatal: detected dubious ownership in repository at /), trust: expect.stringContaining("git config --global --add safe.directory ") });
      expect(await build(0)).toEqual({ code: 0, during: "started\n", after: "started\n" });
    } finally {
      for (const [name, value] of Object.entries(given)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("leaves a build that fails or is cut off unfinished, over an earlier finished one too", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    expect(await build(0)).toMatchObject({ after: finished });
    expect(await build(1)).toEqual({ code: 1, during: "started\n", after: "started\n" });
    delete process.env["OVIS_FROM_SOURCE"];
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["install"], broken)).toMatchObject({ code: 1, sourced: [] });
    expect(existsSync(join(scratch, "server", "source-build"))).toBe(false);
  });

  it("stamps the commit the build started from, and leaves the build unfinished when the checkout moved while it ran", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const home = join(scratch, "server");
    const stamped = async (commits: string[]) => {
      const code = await main(["install"], { home, source: async () => 0, commit: async () => ({ commit: commits.shift()! }) });
      return { code, after: readFileSync(join(home, "source-build"), "utf8") };
    };
    expect(await stamped(["a".repeat(40), "a".repeat(40)])).toEqual({ code: 0, after: `${version} ${"a".repeat(40)}\n` });
    expect(await stamped(["a".repeat(40), "b".repeat(40)])).toEqual({ code: 0, after: "started\n" });
    for (const answers of [[{ commit: "a".repeat(40) }, { failed: "git exited with 128" }], [{ failed: "git exited with 128" }, { commit: "a".repeat(40) }]] as const) {
      const given = [...answers];
      expect(await main(["install"], { home, source: async () => 0, commit: async () => given.shift()! })).toBe(0);
      expect(readFileSync(join(home, "source-build"), "utf8")).toBe("started\n");
    }
  });

  it("says the checkout moved to another commit only where both of git's answers name one, else that git's answer changed", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const home = join(scratch, "server");
    const said: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    try {
      const a = { commit: "a".repeat(40) }, b = { commit: "b".repeat(40) };
      const nested = { none: "nested" } as const, none = { none: "no checkout" } as const;
      for (const [before, after, moved] of [[a, b, true], [none, nested, false], [none, a, false], [a, nested, false]] as const) {
        said.length = 0;
        const given: CheckoutCommit[] = [before, after];
        expect(await main(["install"], { home, source: async () => 0, commit: async () => given.shift()! })).toBe(0);
        expect(readFileSync(join(home, "source-build"), "utf8")).toBe("started\n");
        expect(said.some((line) => line.includes("moved to another commit")), `${JSON.stringify([before, after])}: ${said.join(" | ")}`).toBe(moved);
        expect(said.some((line) => line.includes("git's answer for the checkout changed while it was built"))).toBe(!moved);
      }
    } finally {
      console.error = error;
    }
  });

  it("stamps the version alone for a folder that is not a checkout's top level, not the commit of the repository around it", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const around = join(scratch, "around");
    const plugin = join(around, "plugin");
    mkdirSync(plugin, { recursive: true });
    for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"]]) {
      expect(Bun.spawnSync(["git", "-C", around, ...args]).exitCode).toBe(0);
    }
    const aroundCommit = Bun.spawnSync(["git", "-C", around, "rev-parse", "HEAD"]).stdout.toString().trim();
    expect(await checkoutCommit(around)).toEqual({ commit: aroundCommit });
    expect(await checkoutCommit(plugin)).toEqual({ none: "nested" });
    const home = join(scratch, "server");
    expect(await main(["install"], { home, source: async () => 0, commit: () => checkoutCommit(plugin) })).toBe(0);
    expect(readFileSync(join(home, "source-build"), "utf8")).toBe(`${version}\n`);
  });

  it("names, for a folder git distrusts, a command that trusts it, quoted for a path with a space and an apostrophe, and says it on stderr", async () => {
    process.env["OVIS_FROM_SOURCE"] = "1";
    const folder = join(scratch, "John Doe's plugin");
    mkdirSync(folder);
    for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"]]) {
      expect(Bun.spawnSync(["git", "-C", folder, ...args]).exitCode).toBe(0);
    }
    const set = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: join(scratch, "global-config"), GIT_CONFIG_NOSYSTEM: "1" };
    const given = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
    Object.assign(process.env, set);
    const said: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    try {
      const answer = await checkoutCommit(folder);
      if (!("failed" in answer) || !answer.trust) throw new Error(`no trust command: ${JSON.stringify(answer)}`);
      // the reason the release's binary is not taken there says git distrusts it, not that it is no checkout
      expect(sourceTrees(folder)).toEqual({ error: "git does not trust this folder (another account owns it), so the binaries cannot be tied to their sources" });
      const home = join(scratch, "server");
      expect(await main(["install"], { home, source: async () => 0, commit: () => checkoutCommit(folder) })).toBe(0);
      expect(readFileSync(join(home, "source-build"), "utf8")).toBe("started\n");
      const lines = said.join("\n").split("\n");
      expect(lines).toContain(answer.trust);
      // the command, run as printed in this platform's shell, trusts the folder: git reads its commit then
      const shell = process.platform === "win32" ? ["powershell", "-NoProfile", "-Command", answer.trust] : ["sh", "-c", answer.trust];
      expect(Bun.spawnSync(shell, { env: process.env }).exitCode).toBe(0);
      expect(await checkoutCommit(folder)).toEqual({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
      // on Windows herdr's line may as well be pasted into cmd.exe: its own command, typed there as printed (cmd.exe
      // reading it from its input as from the keyboard), trusts the folder too, once the first one's trust is gone
      if (process.platform === "win32") {
        expect(answer.trustCmd).toBeDefined();
        expect(lines).toContain(answer.trustCmd!);
        rmSync(set.GIT_CONFIG_GLOBAL);
        expect(await checkoutCommit(folder)).toMatchObject({ failed: expect.any(String) });
        const cmd = Bun.spawnSync(["cmd", "/d", "/q"], { env: process.env, stdin: Buffer.from(`${answer.trustCmd}\r\nexit %errorlevel%\r\n`) });
        expect(cmd.exitCode, cmd.stdout.toString()).toBe(0);
        expect(await checkoutCommit(folder)).toEqual({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
      } else expect(answer.trustCmd).toBeUndefined();
      // git's ownership answer is told by its own first line, not by the words anywhere: a missing folder named so is not it
      expect(await checkoutCommit(join(scratch, "no such dubious ownership folder"))).toEqual({ failed: expect.stringContaining("cannot change to") });
    } finally {
      console.error = error;
      for (const [name, value] of Object.entries(given)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // Bun looks a program up on the PATH it started with: a PATH without git needs a process of its own
  it("runs without git on PATH: builds and runs from source, leaving the build unfinished, and gives no binary to sources it cannot tie", async () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const home = join(scratch, "server");
    const script = `
const { main } = await import(${JSON.stringify(join(import.meta.dir, "plugin-launch.ts"))});
const { sourceTrees } = await import(${JSON.stringify(join(import.meta.dir, "server-manifest.ts"))});
const { readFileSync } = await import("node:fs");
const home = ${JSON.stringify(home)};
const calls = [];
const source = async (command) => { calls.push(command); return 0; };
const install = await main(["install"], { home, source });
const stamp = readFileSync(${JSON.stringify(join(home, "source-build"))}, "utf8");
delete process.env.OVIS_FROM_SOURCE;
const status = await main(["status"], { home, source });
console.log(JSON.stringify({ install, stamp, status, calls, trees: sourceTrees() }));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: bin, OVIS_FROM_SOURCE: "1" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ install: 0, stamp: "started\n", status: 0, calls: ["install", "status"], trees: { error: "git is not on PATH, so the binaries cannot be tied to their sources" } });
    expect(err).toContain("git could not read the checkout's commit (git is not on PATH)");
  });

  // Without sources git ties to the release (no git, no checkout, changes not committed) its binary is not installed
  // (none is in these checkouts yet), so nothing the release answers changes the choice: it is not asked.
  // `key`: the release key this checkout pins instead of RELEASE_PUBLIC_KEY, so a release the test signs is checked as
  // the real one is
  function checkout({ packages = true, client = true, stamp, git = false, key }: { packages?: boolean; client?: boolean; stamp?: string; git?: boolean; key?: string } = {}): string {
    const dir = join(scratch, "checkout");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    for (const file of ["plugin-launch.ts", "server-install.ts", "server-manifest.ts", "pty-sidecar.ts"]) copyFileSync(join(import.meta.dir, file), join(dir, "scripts", file));
    if (key !== undefined) {
      const manifest = join(dir, "scripts", "server-manifest.ts");
      writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/export const RELEASE_PUBLIC_KEY = "[^"]*";/, `export const RELEASE_PUBLIC_KEY = ${JSON.stringify(key)};`));
    }
    copyFileSync(join(import.meta.dir, "..", "package.json"), join(dir, "package.json"));
    writeFileSync(join(dir, "scripts", "plugin.ts"), `import { existsSync, readFileSync, rmSync } from "node:fs";
await Bun.write(${JSON.stringify(join(dir, "ran"))}, process.argv.slice(2).join(" "));
const record = ${JSON.stringify(join(dir, "server.pid"))};
const pid = existsSync(record) ? Number(readFileSync(record, "utf8")) : null;
if (process.argv[2] === "stop" && pid !== null) { process.kill(pid, "SIGTERM"); rmSync(record); }
if (process.argv[2] === "status") console.log(pid === null ? "down" : \`running (pid \${pid})\`);
`);
    if (packages) mkdirSync(join(dir, "node_modules"));
    if (client) {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "index.html"), "");
    }
    if (stamp !== undefined) {
      mkdirSync(join(dir, ".ovis", "server"), { recursive: true });
      writeFileSync(join(dir, ".ovis", "server", "source-build"), `${stamp}\n`);
    }
    if (git) {
      for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]]) {
        expect(Bun.spawnSync(["git", "-C", dir, ...args]).exitCode).toBe(0);
      }
    }
    return dir;
  }
  async function startIn(dir: string, { git = false, sources, releases = "https://releases.invalid", command = "start" }: { git?: boolean; sources?: { error: string }; releases?: string; command?: string } = {}) {
    const bin = join(scratch, "no-git");
    mkdirSync(bin, { recursive: true });
    rmSync(join(dir, "ran"), { force: true });
    const script = `
const { main } = await import(${JSON.stringify(pathToFileURL(join(dir, "scripts", "plugin-launch.ts")).href)});
const asked = [];
const fetchFile = async (url) => { asked.push(String(url)); throw new TypeError("fetch failed"); };
const code = await main([${JSON.stringify(command)}], { fetchFile${sources ? `, sources: ${JSON.stringify(sources)}` : ""} });
console.log(JSON.stringify({ code, asked }));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: git ? process.env["PATH"] : bin, OVIS_RELEASES_URL: releases }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const ran = existsSync(join(dir, "ran")) ? readFileSync(join(dir, "ran"), "utf8") : null;
    return { ...(JSON.parse(out.trim().split("\n").at(-1)!) as { code: number; asked: string[] }), ran, marker: existsSync(join(dir, ".ovis", "server", "from-source")), err, out };
  }
  const headOf = (dir: string) => Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]).stdout.toString().trim();
  const stampIn = (dir: string, stamp: string) => {
    mkdirSync(join(dir, ".ovis", "server"), { recursive: true });
    writeFileSync(join(dir, ".ovis", "server", "source-build"), `${stamp}\n`);
  };

  for (const [state, unfinish] of [
    ["its client is gone", (dir: string) => rmSync(join(dir, "dist", "index.html"))],
    ["its packages are gone", (dir: string) => rmSync(join(dir, "node_modules"), { recursive: true })],
    ["a later build was cut off", (dir: string) => stampIn(dir, "started")],
  ] as const) {
    it(`stops, and reports, a server running from a checkout git cannot tie once ${state}`, async () => {
      const dir = checkout();
      const server = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], { stdout: "ignore", stderr: "ignore" });
      try {
        writeFileSync(join(dir, "server.pid"), String(server.pid));
        unfinish(dir);
        const status = await startIn(dir, { command: "status" });
        expect(status).toMatchObject({ code: 0, asked: [], ran: "status", marker: false });
        expect(status.out).toContain(`running (pid ${server.pid})`);
        expect(await startIn(dir, { command: "stop" })).toMatchObject({ code: 0, asked: [], ran: "stop", marker: false });
        expect(await Promise.race([server.exited.then(() => "stopped"), Bun.sleep(10_000).then(() => "still running")])).toBe("stopped");
      } finally {
        server.kill();
      }
    });
  }

  const uncommitted = { error: "server/ or shared/ has changes that are not committed, so the binaries would not be built from HEAD's sources" };
  const noCompiledServer = () => {
    mkdirSync(join(scratch, "release", `v${version}`), { recursive: true });
    return pathToFileURL(join(scratch, "release")).href;
  };
  for (const [path, tied] of [["git ties the sources and the release has no compiled server", true], ["git cannot tie the sources", false]] as const) {
    for (const [what, stamp, said] of [
      ["another version", (_dir: string) => `0.1.0 ${"a".repeat(40)}`, (_dir: string) => ["version 0.1.0", `version ${version}`]],
      ["another commit", (_dir: string) => `${version} ${"a".repeat(40)}`, (dir: string) => ["commit aaaaaaaaaaaa", `commit ${headOf(dir).slice(0, 12)}`]],
    ] as const) {
      it(`starts a complete build of ${what} where ${path}, saying which and how to rebuild it`, async () => {
        const dir = checkout({ git: true });
        stampIn(dir, stamp(dir));
        const result = await startIn(dir, tied ? { git: true, releases: noCompiledServer() } : { git: true, sources: uncommitted });
        expect(result).toMatchObject({ code: 0, asked: [], ran: "start", marker: tied });
        const line = result.err.split("\n").find((text) => text.includes("this checkout's build is of")) ?? "";
        const [built, now] = said(dir);
        expect(line.indexOf(built)).toBeGreaterThan(-1);
        expect(line.indexOf(now)).toBeGreaterThan(line.indexOf(built));
        expect(line).toContain(process.platform === "win32" ? "$env:OVIS_FROM_SOURCE = '1'; bun " : "OVIS_FROM_SOURCE=1 bun ");
        expect(result.err.indexOf(line)).toBeLessThan(result.err.indexOf("so this checkout runs"));
      });
    }
  }

  it("starts nothing where git ties the sources, the release ships no compiled server and the build is not complete, whatever ran before", async () => {
    const dir = checkout({ git: true, client: false });
    const releases = noCompiledServer();
    const start = await startIn(dir, { git: true, releases });
    expect(start).toMatchObject({ code: 1, ran: null, marker: false });
    expect(start.err).toContain("ships no compiled server");
    expect(start.err).toContain("no dist/index.html");
    // regression (fails at 1040c7de: the stop wrote the marker, and the start after it ran the sources unchecked)
    for (const command of ["stop", "status"]) expect(await startIn(dir, { git: true, releases, command })).toMatchObject({ code: 0, ran: command, marker: false });
    expect(await startIn(dir, { git: true, releases })).toMatchObject({ code: 1, ran: null, marker: false });
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.html"), "");
    expect(await startIn(dir, { git: true, releases })).toMatchObject({ code: 0, ran: "start", marker: true });
  });

  for (const [way, said, manifest] of [
    ["the release's manifest has the shape from before schema 1", "shape from before schema 1", (dir: string) => writeFileSync(join(dir, MANIFEST), JSON.stringify({ version }))],
    ["the release was built from other trees (a branch)", "other git trees", (dir: string) => {
      for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
      for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
      writeFileSync(join(dir, "ovis-dist.tar.gz"), "client\n");
      writeManifest(dir, { version, sources: BUILT_FROM });
    }],
  ] as const) {
    it(`starts nothing where ${way} and the build is not complete, and runs a complete one`, async () => {
      const keys = generateKeyPair();
      const dir = checkout({ git: true, client: false, key: keys.publicKey });
      const release = join(scratch, "release", `v${version}`);
      mkdirSync(release, { recursive: true });
      manifest(release);
      signManifest(release, keys.privateKeyPem);
      const releases = pathToFileURL(join(scratch, "release")).href;
      const start = await startIn(dir, { git: true, releases });
      expect(start).toMatchObject({ code: 1, ran: null, marker: false });
      expect(start.err).toContain(said);
      expect(start.err).toContain("no dist/index.html");
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "index.html"), "");
      expect(await startIn(dir, { git: true, releases })).toMatchObject({ code: 0, ran: "start", marker: true });
    });
  }

  it("stops, and reports, a running server where git ties the sources and the release is out of reach; a start still fails", async () => {
    const dir = checkout({ git: true });
    const server = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(dir, "server.pid"), String(server.pid));
      const start = await startIn(dir, { git: true });
      expect(start).toMatchObject({ code: 1, ran: null, marker: false });
      expect(start.err).toContain("could not install the server");
      const status = await startIn(dir, { git: true, command: "status" });
      expect(status).toMatchObject({ code: 0, ran: "status", marker: false });
      expect(status.asked).toEqual([`https://releases.invalid/v${version}/ovis-server.json`]);
      expect(status.out).toContain(`running (pid ${server.pid})`);
      expect(await startIn(dir, { git: true, command: "stop" })).toMatchObject({ code: 0, ran: "stop", marker: false });
      expect(await Promise.race([server.exited.then(() => "stopped"), Bun.sleep(10_000).then(() => "still running")])).toBe("stopped");
    } finally {
      server.kill();
    }
  });

  it("starts a finished build without git, the release out of reach, without asking it, and remembers nothing", async () => {
    const dir = checkout({ stamp: `${version} ${"a".repeat(40)}` });
    expect(await startIn(dir)).toMatchObject({ code: 0, asked: [], ran: "start", marker: false });
    expect(readFileSync(join(dir, ".ovis", "server", "source-build"), "utf8")).toBe(`${version} ${"a".repeat(40)}\n`);
  });

  for (const [state, given, missing] of [
    ["without its client", { client: false }, "no dist/index.html"],
    ["without its packages", { packages: false }, "no node_modules"],
    ["whose last build did not finish", { stamp: "started" }, "its last build did not finish"],
  ] as const) {
    it(`starts nothing without git for a checkout ${state}, saying it needs a build and how`, async () => {
      const result = await startIn(checkout(given));
      expect(result).toMatchObject({ code: 1, asked: [], ran: null, marker: false });
      expect(result.err).toContain(missing);
      expect(result.err).toContain("OVIS_FROM_SOURCE");
    });
  }

  for (const why of ["not a git checkout, so the binaries cannot be tied to their sources", "server/ or shared/ has changes that are not committed, so the binaries would not be built from HEAD's sources"]) {
    it(`starts a finished build without asking the release where ${why.split(",")[0]}, and remembers nothing`, async () => {
      expect(await startIn(checkout(), { git: true, sources: { error: why } })).toMatchObject({ code: 0, asked: [], ran: "start", marker: false });
    });
  }

  it("takes the usual way again once git ties the sources and the release answers: the start without git left nothing behind", async () => {
    const dir = checkout({ git: true });
    expect(await startIn(dir)).toMatchObject({ code: 0, ran: "start", marker: false });
    mkdirSync(join(scratch, "release", `v${version}`), { recursive: true });
    const back = await startIn(dir, { git: true, releases: pathToFileURL(join(scratch, "release")).href });
    expect(back.err).toContain("ships no compiled server");
    expect(back).toMatchObject({ code: 0, ran: "start", marker: true });
  });

  it("gives the cmd.exe form of the trust command only for a folder cmd.exe would read as written", () => {
    const at = (folder: string) => gitFailed(`fatal: detected dubious ownership in repository at '${folder}'\n'${folder}' is owned by:`, "win32");
    expect(at("C:/Users/John O'Brien/plugin")).toMatchObject({ trust: "git config --global --add safe.directory 'C:/Users/John O''Brien/plugin'", trustCmd: `git config --global --add safe.directory "C:/Users/John O'Brien/plugin"` });
    // `%name%` expands in cmd.exe, and `!name!` under delayed expansion (cmd /v:on), inside double quotes too
    for (const folder of ["C:/100%done/plugin", "C:/work/!USER!/plugin"]) expect(at(folder)).not.toHaveProperty("trustCmd");
    expect(gitFailed("fatal: detected dubious ownership in repository at '/home/x/it''s'", "linux")).not.toHaveProperty("trustCmd");
  });

  it("builds from source at the build step without asking the release where git ties no sources to it", async () => {
    const home = join(scratch, "server");
    const asked: string[] = [];
    const code = await main(["install"], { home, fetchFile: offline(asked), sources: { error: "git is not on PATH, so the binaries cannot be tied to their sources" }, source: async () => 0, commit: async () => ({ failed: "git is not on PATH" }) });
    expect({ code, asked, stamp: readFileSync(join(home, "source-build"), "utf8") }).toEqual({ code: 0, asked: [], stamp: "started\n" });
  });

  it("still asks the release where git ties the sources, and fails when it is out of reach", async () => {
    const asked: string[] = [];
    expect(await launch(["start"], offline(asked))).toMatchObject({ code: 1, sourced: [] });
    expect(asked).toEqual([`https://github.com/devswha/ovis/releases/download/v${version}/ovis-server.json`]);
  });

  it("keeps running from source a checkout an older launcher built: a marker and no stamp", async () => {
    const home = join(scratch, "server");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "from-source"), `${version}\n`);
    const broken = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await launch(["start"], broken)).toMatchObject({ code: 7, sourced: [["start"]] });
    expect(existsSync(join(home, "source-build"))).toBe(false);
  });

});

describe("the launcher's child", () => {
  // POSIX signals: on Windows herdr runs scripts/plugin.ps1, and no SIGTERM or SIGHUP reaches a launcher there
  const posix = it.skipIf(process.platform === "win32");
  const launcherModule = JSON.stringify(join(import.meta.dir, "plugin-launch.ts"));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function within<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), 10_000); })]);
    } finally { clearTimeout(timer); }
  }
  /** the launcher runs `script`, its stderr into a file: a child left running would hold a pipe open */
  const launch = (script: string, env: Record<string, string> = {}) =>
    Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ...env }, stdout: "pipe", stderr: Bun.file(join(scratch, "stderr")) });
  const said = () => readFileSync(join(scratch, "stderr"), "utf8");
  function cleanUp(launcher: ReturnType<typeof launch>, pidFile: string): void {
    launcher.kill("SIGKILL");
    const child = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    if (child > 0 && alive(child)) process.kill(child, "SIGKILL");
  }

  posix("gets the SIGTERM sent to the launcher while it runs, and the launcher exits as the child did, leaving no child behind", async () => {
    const pidFile = join(scratch, "child");
    const launcher = launch(`const { run } = await import(${launcherModule});
process.exit(await run(["sh", "-c", 'trap "exit 3" TERM; echo $$ > ${pidFile}; echo up; while :; do sleep 0.05; done']));`);
    try {
      const up = await within(launcher.stdout.getReader().read(), "the child never started");
      expect(new TextDecoder().decode(up.value)).toBe("up\n");
      launcher.kill("SIGTERM");
      const code = await within(launcher.exited, "the launcher never exited");
      expect({ code, childLeft: alive(Number(readFileSync(pidFile, "utf8"))) }, said()).toEqual({ code: 3, childLeft: false });
    } finally { cleanUp(launcher, pidFile); }
  }, 30_000);

  for (const [signal, exit] of [["SIGTERM", 3], ["SIGHUP", 4]] as const) {
    posix(`gets a ${signal} that comes the instant it starts, and the launcher exits as the child did, leaving no child behind`, async () => {
      // A launcher that listens only after the spawn is ended by the signal and leaves its child running; one that
      // listens first passes it on.
      const pidFile = join(scratch, "child");
      const sent = join(scratch, "sent");
      const name = signal.slice(3);
      const launcher = launch(`import { existsSync } from "node:fs";
let spawned = false;
const spawn = Bun.spawn;
Bun.spawn = (...args) => { spawned = true; return spawn(...args); };
process.on("newListener", (event) => {
  if (event !== "${signal}" || !spawned) return;
  for (const deadline = Date.now() + 10_000; !existsSync(${JSON.stringify(sent)});) if (Date.now() > deadline) throw new Error("the child never sent the signal");
});
const { run } = await import(${launcherModule});
process.exit(await run(["sh", "-c", 'trap "exit ${exit}" ${name}; echo $$ > ${pidFile}; kill -${name} $PPID; : > ${sent}; while :; do sleep 0.05; done']));`);
      try {
        const code = await within(launcher.exited, "the launcher never exited");
        expect({ code, childLeft: alive(Number(readFileSync(pidFile, "utf8"))) }, said()).toEqual({ code: exit, childLeft: false });
      } finally { cleanUp(launcher, pidFile); }
    }, 30_000);
  }

  for (const [signal, exit] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    posix(`starts no further build step after a ${signal} that came as one started and found it already ended`, async () => {
      const second = join(scratch, "second-step");
      const pidFile = join(scratch, "child");
      const launcher = launch(`const spawn = Bun.spawn;
let steps = 0;
Bun.spawn = (argv, options) => {
  if (argv[0] !== process.execPath) return spawn(argv, options);
  steps += 1;
  if (steps > 1) return spawn(["sh", "-c", ": >> ${second}"], options);
  process.kill(process.pid, "${signal}");
  const child = spawn(["true"], options);
  // until the step has ended: a zombie, or already reaped
  for (const deadline = Date.now() + 10_000; !/^(Z|$)/.test(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child.pid)]).stdout.toString().trim());) if (Date.now() > deadline) throw new Error("the first step never ended");
  return child;
};
const { main } = await import(${launcherModule});
process.exit(await main(["install"], { home: ${JSON.stringify(join(scratch, "server"))} }));`, { OVIS_FROM_SOURCE: "1" });
      try {
        const code = await within(launcher.exited, "the launcher never exited");
        expect({ code, secondStep: existsSync(second) }, said()).toEqual({ code: exit, secondStep: false });
      } finally { cleanUp(launcher, pidFile); }
    }, 30_000);
  }

  posix("names the first of two signals that came while a build step ran that then ended with 0", async () => {
    const second = join(scratch, "second-step");
    const pidFile = join(scratch, "child");
    const launcher = launch(`const spawn = Bun.spawn;
let steps = 0;
Bun.spawn = (argv, options) => {
  if (argv[0] !== process.execPath) return spawn(argv, options);
  steps += 1;
  if (steps > 1) return spawn(["sh", "-c", ": >> ${second}"], options);
  return spawn(["sh", "-c", 'trap "kill -HUP $PPID" TERM; trap "exit 0" HUP; echo $$ > ${pidFile}; kill -TERM $PPID; while :; do sleep 0.05; done'], options);
};
const { main } = await import(${launcherModule});
process.exit(await main(["install"], { home: ${JSON.stringify(join(scratch, "server"))} }));`, { OVIS_FROM_SOURCE: "1" });
    try {
      const code = await within(launcher.exited, "the launcher never exited");
      expect({ code, secondStep: existsSync(second) }, said()).toEqual({ code: 143, secondStep: false });
    } finally { cleanUp(launcher, pidFile); }
  }, 30_000);

  posix("does not stop a build at a signal an earlier run in the same process was sent", async () => {
    const pidFile = join(scratch, "child");
    const launcher = launch(`const { main, run } = await import(${launcherModule});
const first = await run(["sh", "-c", 'echo $$ > ${pidFile}; kill -TERM $PPID; while :; do sleep 0.05; done']);
const spawn = Bun.spawn;
let steps = 0;
Bun.spawn = (argv, options) => {
  if (argv[0] !== process.execPath) return spawn(argv, options);
  steps += 1;
  return spawn(["true"], options);
};
const code = await main(["install"], { home: ${JSON.stringify(join(scratch, "server"))} });
console.log(JSON.stringify({ first, code, steps }));
process.exit(0);`, { OVIS_FROM_SOURCE: "1" });
    try {
      const [out, code] = await within(Promise.all([new Response(launcher.stdout).text(), launcher.exited]), "the launcher never exited");
      expect(code, said()).toBe(0);
      expect(JSON.parse(out)).toEqual({ first: 143, code: 0, steps: 3 });
    } finally { cleanUp(launcher, pidFile); }
  }, 30_000);

  posix("exits with 128 + the platform's number of whatever signal ended the child", async () => {
    for (const [signal, code] of [["KILL", 137], ["QUIT", 131], ["TERM", 143]] as const) expect([signal, await run(["sh", "-c", `kill -${signal} $$`])]).toEqual([signal, code]);
  });
});
