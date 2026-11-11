import { afterEach, beforeEach, describe, expect, it, jest, setSystemTime } from "bun:test";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { releaseSupervisor as launcherSupervisor } from "./managed.ts";
import { isReleaseFolder, latestTag, NOTES_FILE_LIMIT, readNotesFile, RELEASE_FOLDER_REASON, UPDATE_CHANNEL_FILE, updateChannel, Updater, runCommand, type Release } from "./updater.ts";
import { updateStateDir } from "./update-state.ts";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { HERDR_SOCKET_PATH } from "../shared/protocol.ts";
import type { UpdateCommand } from "../shared/update.ts";

let directory: string, upstream: string, root: string, stateDir: string;
let updater: Updater;
/** every install step the updater published, in order, repeats left out */
let steps: Array<string | null>;
const git = (cwd: string, ...args: string[]) => runCommand(cwd, ["git", ...args]);
async function commit(contents: string, failBuild = false) {
  writeFileSync(join(upstream, "build-fixture.ts"), failBuild ? "throw new Error('fixture build failure');" :
    `await Bun.write('dist/index.html', ${JSON.stringify(contents)});`);
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-qm", contents);
  return git(upstream, "rev-parse", "HEAD");
}
/** Commit and publish it as a release tag; only tags make an update available. */
async function release(contents: string, tag: string, options: { failBuild?: boolean; annotated?: boolean } = {}) {
  const revision = await commit(contents, options.failBuild);
  await git(upstream, "tag", ...(options.annotated ? ["-a", "-m", tag] : []), tag);
  return revision;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "herdr-updater-"));
  upstream = join(directory, "upstream"); root = join(directory, "checkout"); stateDir = join(directory, "state");
  mkdirSync(upstream);
  await git(upstream, "init", "-q", "-b", "main");
  await git(upstream, "config", "user.email", "test@example.invalid");
  await git(upstream, "config", "user.name", "Updater test");
  writeFileSync(join(upstream, "package.json"), JSON.stringify({ name: "updater-fixture", scripts: {
    typecheck: "bun --eval 'process.exit(0)'", build: "bun build-fixture.ts",
  } }));
  writeFileSync(join(upstream, ".gitignore"), "node_modules/\ndist/\n");
  await runCommand(upstream, [process.execPath, "install"]);
  await commit("first");
  await git(directory, "clone", "-q", upstream, root);
  steps = [];
  updater = new Updater({ root, stateDir, autoUpdate: false, activate: async (_next, persist) => persist(),
    publish(status) { const step = status.step ?? null; if (steps.at(-1) !== step) steps.push(step); } });
  await updater.initialize();
});

afterEach(() => {
  updater?.stop();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A port for the managed bridge that nothing listens on, held for a moment to make sure, then given
 * back. The bridge binds it three process starts later (launcher, supervisor, bridge), and again
 * each time an update or a restart replaces the bridge.
 *
 * Below 32768, under the ports a system hands out on its own by default: Linux gives a listener on
 * port 0 or an outgoing connection one from 32768 up (ip_local_port_range), macOS and Windows from
 * 49152 up. A port asked of the system with port 0 and given back is one of those: the next
 * `port: 0` server of a test file running beside this one can be handed it before the bridge binds
 * it, and the bridge then fails to start (EADDRINUSE) while the test waits for its answer. Below
 * 20000 too, where scripts/check.test.ts takes the ports of its runs: the unit tests run beside
 * this file in `bun run check concurrent`.
 */
function bridgePort(): number {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 10_000 + Math.floor(Math.random() * 10_000);
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      return port;
    } catch { /* taken: another port */ }
  }
  throw new Error("no free port for the managed bridge");
}

/**
 * A real launcher + supervisor + bridge on a free port, serving the fixture checkout. Given `home`,
 * they run with it as $HOME and keep their state in the default dir under it, as an install not
 * told OVIS_STATE_DIR does.
 */
async function managedFixture(supervisor?: string, slowHealth = false, home?: string) {
  updater.stop();
  mkdirSync(join(upstream, "server"), { recursive: true });
  const entry = `
    import { createServer } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
    import { connectUpdater } from ${JSON.stringify(join(import.meta.dir, "update-api.ts"))};
    ${slowHealth ? `
    // a busy PC: the bridge answers, but its first six health checks outlast the supervisor's 1 s probe
    // timeout, so they are refused on any machine and the start takes about 6.6 s (fixed 800 ms let a
    // fast PC pass the first probe, and the test then exercised nothing)
    const serve = Bun.serve; let slow = 6;
    Bun.serve = (options) => serve({ ...options, async fetch(request, server) {
      if (new URL(request.url).pathname === "/api/health" && slow-- > 0) await Bun.sleep(1200);
      return options.fetch.call(this, request, server);
    } });` : ""}
    const server = createServer({ updates: connectUpdater() });
    process.on('SIGTERM', () => { server.stop(); setTimeout(() => process.exit(0), 50); });
    process.on('disconnect', () => { server.stop(); process.exit(0); });
  `;
  writeFileSync(join(upstream, "server/index.ts"), entry);
  if (supervisor !== undefined) writeFileSync(join(upstream, "server/supervisor.ts"), supervisor);
  await commit("managed initial");
  await git(root, "pull", "--ff-only", "--quiet");
  const port = bridgePort();
  const origin = `http://127.0.0.1:${port}`;
  const headers = { authorization: "Bearer test-managed-token", "x-herdr-update": "1" };
  // what the launcher, the supervisor and the bridge print: a failed test prints it
  const log = join(directory, "managed.log");
  // its own config home: the launcher links the default state dirs it finds there
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), HOST: "127.0.0.1", OVIS_STATE_DIR: stateDir,
    XDG_CONFIG_HOME: join(directory, "config"), OVIS_TOKEN: "test-managed-token", OVIS_AUTO_UPDATE: "0", SUPERVISOR_MARKER: join(directory, "marker") };
  if (home !== undefined) {
    for (const name of ["OVIS_STATE_DIR", "XDG_CONFIG_HOME"]) delete env[name];
    // herdr's socket stays the test session's (scripts/test-herdr.ts sets it): it is looked for under $HOME otherwise
    Object.assign(env, { HOME: home, HERDR_SOCKET: process.env["HERDR_SOCKET"] });
  }
  const launch = () => {
    // one file for every launch of a test: a separator says which launch printed what
    appendFileSync(log, `--- launch at ${new Date().toISOString()} ---\n`);
    const output = openSync(log, "a");
    try {
      return Bun.spawn([process.execPath, "--eval",
        `import {runManaged} from ${JSON.stringify(join(import.meta.dir, "managed.ts"))}; await runManaged(${JSON.stringify(root)});`], {
        env, stdout: output, stderr: output,
      });
    } finally {
      closeSync(output);
    }
  };
  const readStatus = async () => {
    try { return await (await fetch(`${origin}/api/updates`, { headers })).json() as typeof updater.status; }
    catch { return null; }
  };
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 12_000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Managed update timeout: ${JSON.stringify(await readStatus())}`);
      await Bun.sleep(50);
    }
  };
  const request = async (command: string) => {
    // an install names the release on offer, as the app's controls do
    const offered = command === "install" ? (await readStatus())?.latest_revision : undefined;
    const response = await fetch(`${origin}/api/updates/${command}`, offered === undefined ? { method: "POST", headers }
      : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ expected_revision: offered }) });
    expect(response.status).toBe(202);
  };
  const health = async () => (await (await fetch(`${origin}/api/health`)).json()) as { web_ui: { revision: string; boot_id: string } };
  /** Print the update status and the managed processes' output when the test fails, then fail as it did. */
  const explain = async (error: unknown): Promise<never> => {
    console.error(`managed update status: ${JSON.stringify(await readStatus())}`);
    console.error(`managed process output:\n${existsSync(log) ? readFileSync(log, "utf8").slice(-8000) : "(none)"}`);
    throw error;
  };
  return { launch, readStatus, until, request, health, origin, explain };
}
/** A release's own supervisor: records that it ran, then runs the real one (or fails on purpose). */
const releaseSupervisor = (broken = false) => broken ? "process.exit(3);\n" : `
  import { appendFileSync } from "node:fs";
  appendFileSync(process.env.SUPERVISOR_MARKER, "release\\n");
  const { runSupervisor } = await import(${JSON.stringify(join(import.meta.dir, "supervisor.ts"))});
  await runSupervisor(process.env.OVIS_SOURCE_ROOT);
`;
/**
 * The real supervisor and the files it imports, copied into the fixture's tree: an installed release
 * then runs it from its own folder and finds its state from there, as a real one does.
 */
function copySupervisor(into: string) {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const repo = resolve(import.meta.dir, "..");
  const files = [join(import.meta.dir, "supervisor.ts")];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const copy = join(into, relative(repo, file));
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, source);
    for (const { path } of transpiler.scanImports(source)) {
      const imported = resolve(dirname(file), path);
      if (path.startsWith(".") && !files.includes(imported)) files.push(imported);
    }
  }
}
const liveHerdr = existsSync(process.env["HERDR_SOCKET"] || HERDR_SOCKET_PATH);

/** What `herdr plugin install` leaves behind: a depth-1 checkout of upstream's main. */
async function shallowPlugin() {
  const plugin = join(directory, "plugin");
  mkdirSync(plugin);
  await git(plugin, "init", "-q");
  await git(plugin, "remote", "add", "origin", `file://${upstream}`);
  await git(plugin, "fetch", "-q", "--depth", "1", "origin", "main");
  await git(plugin, "checkout", "-q", "FETCH_HEAD");
  return plugin;
}
/**
 * Stands in for the unshallow fetch, which the fixture's local origin would answer in
 * milliseconds: counts its calls, records the timeout it was given, and fails each time the way
 * an offline or too-slow link does (#1252). `leaves` names what each attempt writes into the
 * checkout's pack directory before it ends, the way git leaves a half-written `tmp_pack_*`
 * behind; a name ending in "/" is a directory, whose removal then fails. `succeeds` ends the
 * attempt without an error, the way a fetch that finishes does.
 */
class OfflineUnshallow extends Updater {
  fetches = 0;
  readonly timeouts: number[] = [];
  leaves: string[] = [];
  succeeds = false;
  /** the message each failed attempt ends with */
  failure = "unshallow fixture offline";
  protected async unshallowFetch(timeout: number, _run?: typeof runCommand): Promise<string> {
    this.fetches++;
    this.timeouts.push(timeout);
    const packDir = join(this.options.root, ".git", "objects", "pack");
    mkdirSync(packDir, { recursive: true });
    for (const name of this.leaves) {
      if (name.endsWith("/")) mkdirSync(join(packDir, name));
      else writeFileSync(join(packDir, name), "half-written");
    }
    if (this.succeeds) return "unshallow fixture done";
    throw new Error(this.failure);
  }
  /** The real fetch method (past this class's stand-in) with a stand-in runner, for a test
   * that checks what it hands on. */
  realUnshallowFetch(timeout: number, run: typeof runCommand): Promise<string> {
    return super.unshallowFetch(timeout, run);
  }
}
/**
 * Stands in for the tag fetch of a check: writes the half-written `tmp_pack_*` a failed fetch
 * leaves behind however it ends and then does not finish, ending the way a cancelled or timed-out
 * one does (#1252). Every other git command runs for real.
 */
class CancelledTagFetch extends Updater {
  fetches = 0;
  protected async git(...args: string[]): Promise<string> {
    if (args[0] !== "fetch" || args.at(-1) !== "+refs/tags/v*:refs/tags/v*") return super.git(...args);
    this.fetches++;
    const packDir = join(this.options.root, ".git", "objects", "pack");
    writeFileSync(join(packDir, `tmp_pack_${this.fetches}`), "half-written");
    return new Promise<string>((_, reject) => {
      this.controller.signal.addEventListener("abort", () => reject(new Error("Update cancelled")), { once: true });
    });
  }
}
/** An updater on the shallow plugin fixture whose unshallow fetch never succeeds. */
const offlineUpdater = (plugin: string) => new OfflineUnshallow({ root: plugin, stateDir: join(directory, "plugin-state"),
  autoUpdate: false, pluginCheckout: true, publish() {}, activate: async (_next, persist) => persist() });

describe("managed source updates with real Git repositories and builds", () => {
  it("gives each release preparation command ten minutes without slowing ordinary discovery", async () => {
    await release("second", "v0.2.0");
    const timers = jest.spyOn(globalThis, "setTimeout");
    try {
      await updater.request("install");
      expect(updater.status.error).toBeNull();
      expect(timers.mock.calls.filter((call) => call[1] === 10 * 60_000)).toHaveLength(7);
      expect(timers.mock.calls.some((call) => call[1] === 30_000)).toBe(true);
    } finally {
      timers.mockRestore();
    }
  });

  it("typechecks on Bun, not on an older node first on herdr's PATH", async () => {
    // tsc is a `#!/usr/bin/env node` script; with install.sh's Node off the PATH (#596), herdr's PATH may start with Node 10
    mkdirSync(join(upstream, "tools"), { recursive: true });
    writeFileSync(join(upstream, "tools", "check-fixture"), "#!/usr/bin/env node\nif (typeof Bun === 'undefined') process.exit(42);\n", { mode: 0o755 });
    const scripts = { typecheck: "./tools/check-fixture", build: "bun build-fixture.ts" };
    writeFileSync(join(upstream, "package.json"), JSON.stringify({ name: "updater-fixture", scripts }));
    await release("second", "v0.2.0");
    const oldNode = join(directory, "old-node");
    mkdirSync(oldNode);
    writeFileSync(join(oldNode, "node"), "#!/bin/sh\necho 'SyntaxError: Unexpected token ?' >&2\nexit 1\n", { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${oldNode}:${path ?? ""}`;
    try {
      await updater.request("install");
    } finally {
      if (path === undefined) delete process.env["PATH"];
      else process.env["PATH"] = path;
    }
    expect(updater.status.error).toBeNull();
    expect(steps).toContain("build");
  });

  it("checks without installing, then builds an exact revision without changing the source", async () => {
    const original = await git(root, "rev-parse", "HEAD");
    writeFileSync(join(upstream, "CHANGELOG.md"), "# Changelog\n\n## [0.2.0] - 2026-10-07\n\n### Added\n- Second.\n");
    const target = await release("second", "v0.2.0");
    await updater.request("check");
    expect(updater.status.available).toBe(true);
    expect(updater.notes).toEqual({ revision: target, releases: [{ version: "0.2.0", date: "2026-10-07", notes: "### Added\n- Second." }], omitted: 0 });
    expect(updater.status.current_revision).toBe(original);
    expect(readdirSync(stateDir).filter(name => name.startsWith("release-"))).toHaveLength(0);
    expect(steps).toEqual([null]);
    await updater.request("install");
    expect(updater.status.error).toBeNull();
    expect(steps).toEqual([null, "download", "dependencies", "typecheck", "build", "restart", null]);
    expect(updater.status.current_revision).toBe(target);
    expect(updater.notes).toEqual({ revision: null, releases: [], omitted: 0 });
    expect(readFileSync(join(updater.release!.directory, "dist/index.html"), "utf8")).toBe("second");
    expect(await git(root, "rev-parse", "HEAD")).toBe(original);
    expect(await git(root, "status", "--porcelain")).toBe("");
    const resumed = new Updater(updater.options);
    expect((await resumed.initialize())?.revision).toBe(target);
    resumed.stop();
  });

  it("resumes a release recorded under either name of a state dir reached through a symlink (#2029)", async () => {
    await release("second", "v0.2.0");
    await updater.request("install");
    expect(updater.status.error).toBeNull();
    // the state dir through a link, as a symlinked $HOME gives it to the launcher, and under its real
    // path, as Bun gives it to an installed release's supervisor: each resumes what the other recorded
    const linked = join(directory, "linked-state");
    symlinkSync(stateDir, linked);
    const saved = JSON.parse(readFileSync(join(stateDir, "current.json"), "utf8")) as Release;
    for (const [recordedUnder, resumedFrom] of [[stateDir, linked], [linked, stateDir]] as const) {
      writeFileSync(join(stateDir, "current.json"), JSON.stringify({ ...saved, directory: join(recordedUnder, basename(saved.directory)) }));
      const resumed = new Updater({ ...updater.options, stateDir: resumedFrom });
      // named as its own state dir names it
      expect((await resumed.initialize())?.directory).toBe(join(resumedFrom, basename(saved.directory)));
      resumed.stop();
    }
  });

  it("keeps the release it replaces when that one was recorded under the other name of its state dir (#2029)", async () => {
    await release("second", "v0.2.0");
    await updater.request("install");
    // recorded under the real path; resumed through a link to it
    const replaced = updater.release!.directory;
    const linked = join(directory, "linked-state");
    symlinkSync(stateDir, linked);
    const resumed = new Updater({ ...updater.options, stateDir: linked });
    expect((await resumed.initialize())?.revision).toBe(updater.release!.revision);
    const target = await release("third", "v0.3.0");
    await resumed.request("install");
    expect(resumed.status.error).toBeNull();
    expect(resumed.status.current_revision).toBe(target);
    // the launcher falls back to the replaced release's supervisor when the new one cannot start
    expect(existsSync(join(replaced, "package.json"))).toBe(true);
    resumed.stop();
  });

  it("resumes no release whose recorded name leaves the state dir, nor one recorded relative (#2029)", async () => {
    await release("second", "v0.2.0");
    await updater.request("install");
    const saved = JSON.parse(readFileSync(join(stateDir, "current.json"), "utf8")) as Release;
    const name = basename(saved.directory);
    mkdirSync(join(saved.directory, "server"));
    writeFileSync(join(saved.directory, "server", "supervisor.ts"), "");
    // state/alias -> outside/child, and a copy of the release at outside/<name>: a process started at
    // state/alias/../<name> runs in the copy, while that name, read as text, is inside the state dir
    const outside = join(directory, "outside");
    mkdirSync(join(outside, "child"), { recursive: true });
    cpSync(saved.directory, join(outside, name), { recursive: true });
    symlinkSync(join(outside, "child"), join(stateDir, "alias"));
    const aliased = [stateDir, "alias", "..", name].join(sep);
    expect(await runCommand(aliased, ["pwd", "-P"])).toBe(realpathSync(join(outside, name)));
    for (const recorded of [aliased, relative(process.cwd(), saved.directory)]) {
      writeFileSync(join(stateDir, "current.json"), JSON.stringify({ ...saved, directory: recorded }));
      const resumed = new Updater(updater.options);
      expect((await resumed.initialize())?.directory).toBe(root);
      resumed.stop();
      expect(launcherSupervisor(root, stateDir)).toBeNull();
    }
    writeFileSync(join(stateDir, "current.json"), JSON.stringify(saved));
    const resumed = new Updater(updater.options);
    expect((await resumed.initialize())?.directory).toBe(saved.directory);
    resumed.stop();
    expect(launcherSupervisor(root, stateDir)).toBe(join(saved.directory, "server", "supervisor.ts"));
  });

  it("keeps an offer up while a later check runs, and ends it only with a check's answer (#3325)", async () => {
    const target = await release("second", "v0.2.0");
    // the page polls the published status: a check that withdrew the offer while it ran made the
    // app-wide line blink out, and the terminal under it resize
    const published: Array<{ phase: string; available: boolean }> = [];
    const watched = new Updater({ ...updater.options, publish(status) { published.push({ phase: status.phase, available: status.available }); } });
    await watched.initialize();
    await watched.request("check");
    expect(watched.status).toMatchObject({ available: true, latest_revision: target });
    published.length = 0;
    await watched.request("check");
    expect(published.at(0)).toEqual({ phase: "checking", available: true });
    expect(published.filter((status) => !status.available)).toEqual([]);

    // a check that cannot reach the releases ends the offer: the server refuses an install then
    await git(root, "remote", "set-url", "origin", join(directory, "missing"));
    await watched.request("check");
    expect(watched.status).toMatchObject({ phase: "error", available: false });
    await git(root, "remote", "set-url", "origin", upstream);
    await watched.request("check");
    expect(watched.status).toMatchObject({ phase: "idle", available: true });

    // so does a check that finds the checkout blocked
    writeFileSync(join(root, "local-change.txt"), "x");
    await watched.request("check");
    expect(watched.status.blocked_reason).not.toBeNull();
    expect(watched.status.available).toBe(false);
    watched.stop();
  });

  it("ends the offer when the checkout becomes blocked while the release builds (#3325)", async () => {
    await release("second", "v0.2.0");
    // the checkout changes while the release builds: the check after the build finds it blocked
    const building = new Updater({ ...updater.options, publish(status) {
      if (status.step === "build" && !existsSync(join(root, "local-change.txt"))) writeFileSync(join(root, "local-change.txt"), "x");
    } });
    await building.initialize();
    await building.request("install");
    expect(building.status.phase).toBe("error");
    expect(building.status.blocked_reason).toContain("local changes");
    expect(building.status.available).toBe(false);
    building.stop();
  });

  it("never shows an offer under a channel it was not made on while the check runs (#3325)", async () => {
    const appState = join(directory, "app-state");
    mkdirSync(appState);
    writeFileSync(join(appState, UPDATE_CHANNEL_FILE), "beta\n");
    const published: Array<{ phase: string; channel: string | undefined; available: boolean }> = [];
    const switched = new Updater({ root, stateDir, autoUpdate: false, activate: async (_next, persist) => persist(),
      publish(status) { published.push({ phase: status.phase, channel: status.channel, available: status.available }); },
      channel: () => updateChannel({}, appState) });
    await switched.initialize();
    await release("beta", "beta/v0.2.0-beta.1");
    await switched.request("check");
    expect(switched.status).toMatchObject({ channel: "beta", available: true });
    writeFileSync(join(appState, UPDATE_CHANNEL_FILE), "stable\n");
    published.length = 0;
    await switched.request("check");
    expect(published.filter((status) => status.channel === "stable" && status.available)).toEqual([]);
    switched.stop();
  });

  it("tells what an update brings from the release's own changelog, every release since the running one", async () => {
    const manifest = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(upstream, "package.json"), JSON.stringify({ ...manifest, version: "0.1.0" }));
    await commit("versioned");
    await git(root, "pull", "--ff-only", "--quiet");
    // the notes are there when the status that offers the update is published, not after it
    let offered: unknown = null;
    const versioned = new Updater({ ...updater.options, publish(status) { if (status.available) offered = versioned.notes; } });
    await versioned.initialize();
    expect(versioned.status.current_version).toBe("0.1.0");

    const section = (version: string) => `## [${version}] - 2026-10-07\n\n### Added\n- Release ${version}.\n`;
    writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n${section("0.2.0")}`);
    await release("second", "v0.2.0");
    writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n${section("0.3.0")}\n${section("0.2.0")}`);
    const third = await release("third", "v0.3.0");
    // main moves on after the release: an entry the install does not bring
    writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n- Later.\n\n${section("0.4.0")}\n${section("0.3.0")}\n${section("0.2.0")}`);
    await commit("unreleased work");
    await versioned.request("check");
    expect(versioned.status.available).toBe(true);
    expect(versioned.notes.releases.map((entry) => [entry.version, entry.notes])).toEqual([
      ["0.3.0", "### Added\n- Release 0.3.0."], ["0.2.0", "### Added\n- Release 0.2.0."],
    ]);
    // the notes name the commit they were read from: the one the status offers
    expect(versioned.notes.revision).toBe(third);
    expect(versioned.status.latest_revision).toBe(third);
    expect(offered).toEqual(versioned.notes);

    // a release that ships no changelog is offered all the same, without notes
    await release("fourth", "v0.5.0");
    await git(upstream, "rm", "-q", "CHANGELOG.md");
    const fifth = await release("fifth", "v0.6.0");
    await versioned.request("check");
    expect(versioned.status.error).toBeNull();
    expect(versioned.status.latest_version).toBe("0.6.0");
    expect(versioned.status.available).toBe(true);
    expect(versioned.notes).toEqual({ revision: fifth, releases: [], omitted: 0 });
    versioned.stop();
  });

  it("tells a release by its summary, and what the update brought once it runs", async () => {
    const manifest = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8")) as Record<string, unknown>;
    const cut = (version: string, sections: string[], summaries: Record<string, Record<string, Record<string, string[]>>> | null) => {
      writeFileSync(join(upstream, "package.json"), JSON.stringify({ ...manifest, version }));
      writeFileSync(join(upstream, "CHANGELOG.md"), `# Changelog\n\n${sections.map((entry) => `## [${entry}] - 2026-10-07\n\n### Added\n- Release ${entry}.\n`).join("\n")}`);
      if (summaries) writeFileSync(join(upstream, "release-summaries.json"), JSON.stringify(summaries));
      else rmSync(join(upstream, "release-summaries.json"), { force: true });
    };
    cut("0.1.0", ["0.1.0"], null);
    await commit("versioned");
    await git(root, "pull", "--ff-only", "--quiet");
    // what the last update brought is there when the status that names the new revision is published
    let told: unknown = null;
    const versioned = new Updater({ ...updater.options, publish(status) { if (status.current_version === "0.2.0" && told === null) told = versioned.installed; } });
    await versioned.initialize();
    // the source checkout: for its commit, the answer is that no update installed it
    const none = { revision: await git(root, "rev-parse", "HEAD"), version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 };
    expect(versioned.installed).toEqual(none);

    const summary = { en: { new: ["A second release."], fixed: ["The first one."] }, ko: { new: ["두 번째 릴리스."], fixed: ["첫 번째 릴리스."] } };
    cut("0.2.0", ["0.2.0", "0.1.0"], { "0.2.0": summary, "0.1.0": { en: { new: ["The first."] } } });
    const second = await release("second", "v0.2.0");
    await versioned.request("check");
    const brought = [{ version: "0.2.0", date: "2026-10-07", notes: "### Added\n- Release 0.2.0.", summary }];
    expect(versioned.notes).toEqual({ revision: second, releases: brought, omitted: 0 });
    expect(versioned.installed).toEqual(none);

    const before = Date.now();
    await versioned.request("install");
    expect(versioned.status.error).toBeNull();
    expect(versioned.installed).toMatchObject({ revision: second, version: "0.2.0", previous_version: "0.1.0", releases: brought, omitted: 0 });
    expect(Date.parse(versioned.installed.installed_at!)).toBeGreaterThanOrEqual(before);
    expect(told).toEqual(versioned.installed);
    // the supervisor the release starts was not there for the install: it reads what that one wrote down
    const resumed = new Updater({ ...versioned.options, publish() {} });
    await resumed.initialize();
    expect(resumed.installed).toEqual(versioned.installed);

    // a build left behind by an install that was cut short is a later version, and no release that ran
    const stray = join(stateDir, "release-stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "package.json"), JSON.stringify({ version: "0.2.5" }));
    // the next update replaces the release that runs, not that build and not the source checkout,
    // and one that wrote no summary is told by its section
    cut("0.3.0", ["0.3.0", "0.2.0", "0.1.0"], null);
    const third = await release("third", "v0.3.0");
    await resumed.request("install");
    expect(resumed.status.error).toBeNull();
    expect(resumed.installed).toMatchObject({ revision: third, version: "0.3.0", previous_version: "0.2.0",
      releases: [{ version: "0.3.0", date: "2026-10-07", notes: "### Added\n- Release 0.3.0." }], omitted: 0 });
    const later = new Updater({ ...versioned.options, publish() {} });
    await later.initialize();
    expect(later.installed).toEqual(resumed.installed);

    // a release installed by a supervisor older than that record: the version it replaced is the
    // newest older build still here, and the time is the record's own
    const record = join(stateDir, "current.json");
    const { previous_version: _previous, installed_at: _at, ...legacy } = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
    writeFileSync(record, JSON.stringify(legacy));
    const inferred = new Updater({ ...versioned.options, publish() {} });
    await inferred.initialize();
    expect(inferred.installed).toMatchObject({ revision: third, version: "0.3.0", previous_version: "0.2.0" });
    expect(Number.isFinite(Date.parse(inferred.installed.installed_at!))).toBe(true);

    // a file too large to be notes is not read: summaries of that size leave the changelog, a changelog of that size leaves the update
    writeFileSync(join(inferred.release!.directory, "release-summaries.json"), JSON.stringify({ "0.3.0": { en: { new: ["x".repeat(2_100_000)] } } }));
    const unsummarized = new Updater({ ...versioned.options, publish() {} });
    await unsummarized.initialize();
    expect(unsummarized.installed.releases).toEqual([{ version: "0.3.0", date: "2026-10-07", notes: "### Added\n- Release 0.3.0." }]);
    writeFileSync(join(inferred.release!.directory, "CHANGELOG.md"), `## [0.3.0]\n${"- x\n".repeat(600_000)}`);
    const untold = new Updater({ ...versioned.options, publish() {} });
    await untold.initialize();
    expect(untold.installed).toMatchObject({ version: "0.3.0", previous_version: "0.2.0", releases: [], omitted: 0 });
    for (const each of [versioned, resumed, later, inferred, unsummarized, untold]) each.stop();
  });

  it("refuses local changes, detached branches, and an ahead/diverged history", async () => {
    await commit("second");
    writeFileSync(join(root, "user-draft.txt"), "preserve");
    await updater.request("install");
    expect(updater.status.blocked_reason).toContain("local changes");
    expect(readFileSync(join(root, "user-draft.txt"), "utf8")).toBe("preserve");
    rmSync(join(root, "user-draft.txt"));
    await git(root, "checkout", "--detach", "--quiet");
    await updater.request("install");
    expect(updater.status.blocked_reason).toContain("main");
    await git(root, "checkout", "main", "--quiet");
    await git(upstream, "checkout", "--orphan", "replacement", "--quiet");
    await release("unrelated", "v9.0.0");
    await git(upstream, "branch", "-M", "main");
    await updater.request("install");
    expect(updater.status.available).toBe(false);
    expect(updater.status.blocked_reason).toContain("release history");
  });

  it("says to restart from the source checkout when the launcher runs from an installed release (#1373)", async () => {
    // an installed release, where install puts it: a detached clone under the checkout's update state
    const installed = join(updateStateDir(root, 7317, join(directory, "app-state")), "release-AbC123");
    mkdirSync(installed, { recursive: true });
    await git(installed, "clone", "-q", root, ".");
    await git(installed, "checkout", "-q", "--detach");
    expect(isReleaseFolder(installed)).toBe(true);
    expect(isReleaseFolder(root)).toBe(false);
    expect(isReleaseFolder(join(directory, "updates", "not-a-hash", "release-AbC123"))).toBe(false);
    // herdr's plugin root pointing at it does not make it a source checkout either
    for (const pluginCheckout of [false, true]) {
      const launched = new Updater({ root: installed, stateDir: join(directory, "release-state"), autoUpdate: false, pluginCheckout,
        publish() {}, activate: async (_next, persist) => persist() });
      await launched.initialize();
      expect(launched.status.blocked_reason).toBe(RELEASE_FOLDER_REASON);
      await launched.request("check");
      expect(launched.status.blocked_reason).toBe(RELEASE_FOLDER_REASON);
      launched.stop();
    }
  });

  it("updates a herdr-managed plugin checkout: shallow, detached, owned by herdr", async () => {
    // What `herdr plugin install` leaves behind: a depth-1 fetch checked out as FETCH_HEAD.
    const plugin = join(directory, "plugin");
    mkdirSync(plugin);
    await git(plugin, "init", "-q");
    await git(plugin, "remote", "add", "origin", `file://${upstream}`);
    await git(plugin, "fetch", "-q", "--depth", "1", "origin", "main");
    await git(plugin, "checkout", "-q", "FETCH_HEAD");
    const original = await git(plugin, "rev-parse", "HEAD");
    const pluginState = join(directory, "plugin-state");
    const make = (pluginCheckout: boolean) => new Updater({ root: plugin, stateDir: pluginState, autoUpdate: false, pluginCheckout,
      publish() {}, activate: async (_next, persist) => persist() });

    const outside = make(false);
    await outside.initialize();
    expect(outside.status.blocked_reason).toContain("main");
    outside.stop();

    const managed = make(true);
    await managed.initialize();
    expect(managed.status.blocked_reason).toBeNull();
    const target = await release("second", "v0.2.0");
    await managed.request("install");
    expect(managed.status.error).toBeNull();
    expect(managed.status.current_revision).toBe(target);
    expect(readFileSync(join(managed.release!.directory, "dist/index.html"), "utf8")).toBe("second");
    expect(await git(plugin, "rev-parse", "HEAD")).toBe(original);
    expect(await git(plugin, "status", "--porcelain")).toBe("");
    managed.stop();

    // the same checkout started from a shell, without HERDR_PLUGIN_ROOT: no updates, but the
    // release it already installed still runs instead of the older source checkout
    const restarted = make(false);
    expect((await restarted.initialize())?.revision).toBe(target);
    expect(restarted.status.blocked_reason).toContain("main");
    restarted.stop();
    // local changes there are someone's own work: the source checkout runs, as before
    writeFileSync(join(plugin, "user-draft.txt"), "preserve");
    const edited = make(false);
    expect((await edited.initialize())?.directory).toBe(plugin);
    edited.stop();
    rmSync(join(plugin, "user-draft.txt"));
    // a clean named branch is not a herdr plugin checkout either: the source checkout runs
    await git(plugin, "checkout", "-q", "-b", "feature");
    const branched = make(false);
    expect((await branched.initialize())?.directory).toBe(plugin);
    branched.stop();
  });

  it("follows only plain vX.Y.Z tags: untagged commits, bundle tags and pre-releases stay put", async () => {
    await commit("untagged work on main");
    await git(upstream, "tag", "remote-v9");
    await git(upstream, "tag", "v1.0.0-rc1");
    await updater.request("check");
    expect(updater.status.error).toBeNull();
    expect(updater.status.available).toBe(false);
    expect(updater.status.latest_version).toBeNull();

    const target = await release("released", "v0.10.0", { annotated: true });
    await release("older", "v0.9.0");
    await git(upstream, "reset", "-q", "--hard", target);
    await updater.request("check");
    expect(updater.status.latest_version).toBe("0.10.0");
    // the annotated tag peels to the commit that builds and health checks report
    expect(updater.status.latest_revision).toBe(target);
    expect(updater.status.available).toBe(true);
    await updater.request("install");
    expect(updater.status.error).toBeNull();
    expect(updater.status.current_revision).toBe(target);
  });

  it("never offers a beta build on the stable channel", async () => {
    await release("beta", "beta/v0.2.0-beta.3");
    await git(upstream, "tag", "v0.3.0-beta.1");
    await updater.request("check");
    expect(updater.status.channel).toBe("stable");
    expect(updater.status.available).toBe(false);
    expect(updater.status.latest_version).toBeNull();
    // a stable updater fetches refs/tags/v* alone, as every released one did (v0.4.18 to v0.4.22):
    // the beta/* tags never reach its checkout
    expect(await git(root, "for-each-ref", "refs/tags/beta/")).toBe("");
    expect(await git(root, "tag", "--list", "v0.3.0-beta.1")).toBe("v0.3.0-beta.1");
  });

  it("on the beta channel, installs the newest beta build, and takes the release after it", async () => {
    const appState = join(directory, "app-state");
    mkdirSync(appState);
    const beta = new Updater({ root, stateDir, autoUpdate: false, activate: async (_next, persist) => persist(), publish() {},
      channel: () => updateChannel({}, appState) });
    await beta.initialize();
    await release("released", "v0.2.0");
    await release("beta nine", "beta/v0.2.1-beta.9");
    // a pre-release under v* is no beta build: never taken, on either channel
    await release("rc", "v0.2.1-rc.1");
    const newest = await release("beta ten", "beta/v0.2.1-beta.10");
    await beta.request("check");
    // no setting file yet: the PC has not opted in
    expect(beta.status.channel).toBe("stable");
    expect(beta.status.latest_version).toBe("0.2.0");

    // the file takes effect at the next check, without a restart
    writeFileSync(join(appState, UPDATE_CHANNEL_FILE), "beta\n");
    await beta.request("install");
    expect(beta.status.error).toBeNull();
    expect(beta.status.channel).toBe("beta");
    expect(beta.status.current_revision).toBe(newest);

    const stable = await release("release", "v0.2.1");
    await beta.request("check");
    expect(beta.status.latest_version).toBe("0.2.1");
    expect(beta.status.latest_revision).toBe(stable);
    expect(beta.status.available).toBe(true);
  });

  it("treats a shallow plugin checkout ahead of the latest release as up to date", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = join(directory, "plugin");
    mkdirSync(plugin);
    await git(plugin, "init", "-q");
    await git(plugin, "remote", "add", "origin", `file://${upstream}`);
    await git(plugin, "fetch", "-q", "--depth", "1", "origin", "main");
    await git(plugin, "checkout", "-q", "FETCH_HEAD");
    const managed = new Updater({ root: plugin, stateDir: join(directory, "plugin-state"), autoUpdate: false, pluginCheckout: true,
      publish() {}, activate: async (_next, persist) => persist() });
    await managed.initialize();
    await managed.request("check");
    expect(managed.status.error).toBeNull();
    expect(managed.status.blocked_reason).toBeNull();
    expect(managed.status.latest_version).toBe("0.1.0");
    expect(managed.status.available).toBe(false);
    await release("third", "v0.2.0");
    await managed.request("check");
    expect(managed.status.available).toBe(true);
    managed.stop();
  });

  it("holds a failed unshallow fetch off instead of retrying it on every check", async () => {
    // on a slow link, each 5-minute check re-downloaded the same history and left a half-written
    // tmp_pack_* behind: 17 GiB in three days (#1252). The plugin sits ahead of the latest
    // release, the one checkout shape whose ancestry the shallow grafts cannot answer.
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    await managed.initialize();
    await managed.request("check");
    expect(managed.fetches).toBe(1);
    // the check fails the way a failed fetch does, not with "not part of the release history"
    expect(managed.status.phase).toBe("error");
    expect(managed.status.blocked_reason).toBeNull();
    await managed.request("check");
    expect(managed.fetches).toBe(1);
    expect(managed.status.error).toContain("not fully fetched");
    managed.stop();
  });

  it("tries the unshallow fetch again for a user's own request, without waiting the backoff out", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    await managed.initialize();
    await managed.request("check");
    expect(managed.fetches).toBe(1);
    // the backoff holds the 5-minute cycle off, not a user's own request: asked for, the
    // history fetch runs again at once, the way Update retries a revision automatic install
    // gave up on. After a failed check the API refuses an install (nothing is available):
    // the user's way out is Check, so it is a user's Check that must not be held off
    await managed.request("check", true);
    expect(managed.fetches).toBe(2);
    // what it tells is the fetch's own failure, not the backoff's "next attempt is at …"
    expect(managed.status.error).toContain("unshallow fixture offline");
    managed.stop();
  });

  it("marks the bridge's update commands as the user's own, and hands an install its revision", async () => {
    // The supervisor's IPC is the only road a browser's Check or Update travels to the updater,
    // and runSupervisor builds that updater itself, in its own process: a stand-in child swaps a
    // recording updater in and reports what the IPC handler handed it. Without the flag, a
    // manual Check would wait a failed unshallow fetch's backoff out with the 5-minute timer
    // (#1252). Without the revision, the install's own check would install whatever release it
    // finds, not the one the person was shown; and an older bridge's install, which names none,
    // must not reach the updater at all.
    const root = mkdtempSync(join(directory, "supervisor-root-"));
    const stateDir = mkdtempSync(join(directory, "supervisor-state-"));
    const record = join(directory, "supervisor-record.json");
    const script = join(directory, "supervisor-stand-in.ts");
    const offered = "a".repeat(40);
    writeFileSync(script, `
      import { mock } from "bun:test";
      import { writeFileSync } from "node:fs";
      const supervisor = ${JSON.stringify(join(import.meta.dir, "supervisor.ts"))};
      const updater = ${JSON.stringify(join(import.meta.dir, "updater.ts"))};
      const root = ${JSON.stringify(root)};
      const record = ${JSON.stringify(record)};
      const calls: Array<[string, boolean | null, string | null]> = [];
      const sent: unknown[] = [];
      let recorded: () => void = () => {};
      const onInstall = new Promise<void>((resolve) => { recorded = resolve; });
      const { Updater } = await import(updater);
      class Recording extends Updater {
        override async initialize() { return { directory: root, revision: "0".repeat(40), source_revision: "0".repeat(40) }; }
        override start() { /* this stand-in has no 5-minute timer to run */ }
        override async request(command: string, byUser?: boolean, expectedRevision?: string) {
          calls.push([command, byUser ?? null, expectedRevision ?? null]);
          if (command === "install") recorded();
        }
      }
      mock.module(updater, () => ({ Updater: Recording }));
      // the bridge without a bridge: the supervisor's health check is answered, its IPC captured
      let ipc: (message: unknown) => void = () => {};
      let bootId = "";
      const realSpawn = Bun.spawn, realFetch = globalThis.fetch;
      Bun.spawn = ((_argv: string[], options: { env: Record<string, string>; ipc: (message: unknown) => void }) => {
        bootId = options.env["OVIS_BOOT_ID"]!;
        ipc = options.ipc;
        return { exitCode: null, kill() {}, exited: Promise.resolve(0), send(message: unknown) { sent.push(message); } };
      }) as unknown as typeof Bun.spawn;
      globalThis.fetch = (async () => ({ ok: true, json: async () => ({ web_ui: { boot_id: bootId } }) })) as unknown as typeof fetch;
      const { runSupervisor } = await import(supervisor);
      await runSupervisor(root);
      ipc({ type: "update-command", command: "check" });
      // an older bridge's Update names no revision: it is refused, not run as an install
      ipc({ type: "update-command", command: "install" });
      ipc({ type: "update-install-revision", expected_revision: ${JSON.stringify(offered)} });
      // the handler runs the requests in the order they came, so once an install is recorded every
      // message before it has been handled too
      await Promise.race([onInstall, Bun.sleep(5_000)]); // fixed wait: nothing else ever arrives
      writeFileSync(record, JSON.stringify({ calls, sent }));
      Bun.spawn = realSpawn;
      globalThis.fetch = realFetch;
      process.exit(0);
    `);
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, PORT: "59999", HOST: "127.0.0.1",
      OVIS_STATE_DIR: stateDir, XDG_CONFIG_HOME: join(stateDir, "config"), OVIS_AUTO_UPDATE: "0" }, stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000); // a wedged stand-in must not hang the run
    try {
      expect(await child.exited).toBe(0);
      if (!existsSync(record)) throw new Error(`no record was written; the stand-in printed:\n${(await output).join("\n")}`);
      const told = JSON.parse(readFileSync(record, "utf8")) as { calls: unknown[]; sent: Array<{ type?: string; status?: { revision_bound_install?: unknown } }> };
      expect(told.calls).toEqual([["check", true, null], ["install", true, offered]]);
      // and it tells the bridge it installs only the revision named, so the bridge offers installs
      const statuses = told.sent.filter((message) => message.type === "update-status");
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every((message) => message.status?.revision_bound_install === true)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  }, 20_000);

  it("takes a bridge by its own answer, or by the whole one when it predates the bridge-scope boot id, and tells it", async () => {
    // runSupervisor in a stand-in child, as above: the bridge is a fake whose health answers say what
    // a bridge of this revision says (its boot id and runtime in ?scope=bridge) or an older one (none)
    const asked = async (older: boolean, herdrSocket?: string, runtime = "herdr") => {
      const root = mkdtempSync(join(directory, "launch-root-"));
      const stateDir = mkdtempSync(join(directory, "launch-state-"));
      const record = join(stateDir, "launch-record.json");
      const script = join(stateDir, "launch-stand-in.ts");
      writeFileSync(script, `
        import { mock } from "bun:test";
        import { writeFileSync } from "node:fs";
        const { Updater } = await import(${JSON.stringify(join(import.meta.dir, "updater.ts"))});
        class Idle extends Updater {
          override async initialize() { return { directory: ${JSON.stringify(root)}, revision: "0".repeat(40), source_revision: "0".repeat(40) }; }
          override start() {}
        }
        mock.module(${JSON.stringify(join(import.meta.dir, "updater.ts"))}, () => ({ Updater: Idle }));
        const urls: string[] = [];
        const sent: unknown[] = [];
        let bootId = "";
        Bun.spawn = ((_argv: string[], options: { env: Record<string, string> }) => {
          bootId = options.env["OVIS_BOOT_ID"]!;
          return { exitCode: null, kill() {}, exited: new Promise(() => {}), send(message: unknown) { sent.push(message); } };
        }) as unknown as typeof Bun.spawn;
        globalThis.fetch = (async (url: string) => {
          urls.push(new URL(url).search);
          const bridge = new URL(url).search === "?scope=bridge";
          return { ok: true, json: async () => bridge ? (${older} ? { ok: true } : { ok: true, web_ui: { boot_id: bootId }, runtime: ${JSON.stringify(runtime)} }) : { web_ui: { boot_id: bootId } } };
        }) as unknown as typeof fetch;
        await (await import(${JSON.stringify(join(import.meta.dir, "supervisor.ts"))})).runSupervisor(${JSON.stringify(root)});
        writeFileSync(${JSON.stringify(record)}, JSON.stringify({ urls, sent }));
        process.exit(0);
      `);
      // no herdr socket by default: a bridge of this revision serving herdr needs no whole answer
      const child = Bun.spawn([process.execPath, script], { env: { ...process.env, PORT: "59998", HOST: "127.0.0.1", OVIS_STATE_DIR: stateDir,
        XDG_CONFIG_HOME: join(stateDir, "config"), HERDR_SOCKET: herdrSocket ?? join(stateDir, "no-herdr.sock"), OVIS_AUTO_UPDATE: "0" }, stdout: "pipe", stderr: "pipe" });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000); // a wedged stand-in must not hang the run
      try {
        expect(await child.exited).toBe(0);
        if (!existsSync(record)) throw new Error(`no record was written; the stand-in printed:\n${(await output).join("\n")}`);
        return JSON.parse(readFileSync(record, "utf8")) as { urls: string[]; sent: Array<{ type?: string }> };
      } finally {
        clearTimeout(timer);
      }
    };
    const current = await asked(false);
    expect(current.urls).toEqual(["?scope=bridge"]);
    expect(current.sent.filter((message) => message.type === "bridge-accepted")).toHaveLength(1);
    const older = await asked(true);
    expect(older.urls).toEqual(["?scope=bridge", ""]);
    expect(older.sent.filter((message) => message.type === "bridge-accepted")).toHaveLength(1);
    // a runtime the bridge starts itself must answer, whichever it is: none is taken on the bridge's word alone
    for (const runtime of ["herdr-core", "alt-runtime"]) expect((await asked(false, undefined, runtime)).urls).toEqual(["?scope=bridge", ""]);
    if (process.platform === "win32") return; // herdr's socket is a named pipe there: no unix socket file is left behind
    // a socket file a killed herdr left behind refuses the connect: herdr is stopped, as with no socket (#2670)
    const stale = join(mkdtempSync(join(directory, "stale-")), "herdr.sock");
    const holder = Bun.spawn([process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(stale)}, socket: { data() {} } }); console.log("listening");`], { stdout: "pipe" });
    await holder.stdout.getReader().read();
    holder.kill("SIGKILL");
    await holder.exited;
    expect(existsSync(stale)).toBe(true);
    expect((await asked(false, stale)).urls).toEqual(["?scope=bridge"]);
    // a herdr that answers the connect must answer the whole health check too
    const live = join(mkdtempSync(join(directory, "live-")), "herdr.sock");
    const listener = Bun.listen({ unix: live, socket: { data() {} } });
    try {
      expect((await asked(false, live)).urls).toEqual(["?scope=bridge", ""]);
    } finally {
      listener.stop(true);
    }
  }, 60_000);

  it("holds the timer off after a user's own failed unshallow fetch too", async () => {
    // a user's Check skips the backoff, but its failure still starts one: the timer that comes
    // next does not fetch the history again (#1252)
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    await managed.initialize();
    await managed.request("check", true);
    expect(managed.fetches).toBe(1);
    await managed.request("check");
    expect(managed.fetches).toBe(1);
    expect(managed.status.error).toContain("not fully fetched");
    managed.stop();
  });

  it("runs the timer's checks as the timer's, never as a user's", () => {
    // the backoff holds only the timer (#1252): a timer that marked its checks as a user's would
    // fetch the missing history again every 5 minutes
    const flags: Array<boolean | undefined> = [];
    class Timed extends Updater {
      override async request(_command: UpdateCommand, byUser?: boolean) { flags.push(byUser); }
    }
    const timed = new Timed({ root, stateDir, autoUpdate: false, publish() {}, activate: async (_next, persist) => persist() });
    jest.useFakeTimers();
    try {
      timed.start();
      jest.advanceTimersByTime(10_000 + 2 * 5 * 60_000);
    } finally { timed.stop(); jest.useRealTimers(); }
    expect(flags).toHaveLength(3);
    expect(flags.every((flag) => !flag)).toBe(true);
  });

  it("tries the unshallow fetch again once the backoff is over", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    await managed.initialize();
    await managed.request("check");
    expect(managed.fetches).toBe(1);
    // six hours later (the backoff), the next check downloads the history again
    const start = Date.now();
    try {
      setSystemTime(start + 6 * 60 * 60_000 + 1_000);
      await managed.request("check");
    } finally {
      setSystemTime();
    }
    expect(managed.fetches).toBe(2);
    managed.stop();
  });

  it("gives the unshallow fetch its own, much longer timeout than an ordinary command", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    await managed.initialize();
    await managed.request("check");
    expect(managed.timeouts).toEqual([10 * 60_000]);
    // and the real fetch method hands that timeout to its command runner, not only to the
    // stand-in above: what it runs, and with which bound, is checked where it is given
    const runs: Array<{ argv: string[]; timeout?: number }> = [];
    await managed.realUnshallowFetch(10 * 60_000, (_cwd, argv, _signal, timeout) => {
      runs.push({ argv, timeout });
      return Promise.resolve("fixture run");
    });
    expect(runs).toEqual([{ argv: ["git", "fetch", "--no-tags", "--unshallow", "origin"], timeout: 10 * 60_000 }]);
    managed.stop();
  });

  it("removes the tmp_pack_* a failed tag fetch left behind", async () => {
    // The tag fetch of every check is the same leak the unshallow one was: a failed fetch
    // leaves its half-written tmp_pack_* behind however it ends — a timeout, a cancellation,
    // or git's own exit on a dropped connection (measured on git 2.54; #1252) — and every
    // 5-minute check added another. Its own checkout, so a failure here colors no other test.
    const own = join(directory, "tag-fetch-checkout");
    await git(directory, "clone", "-q", upstream, own);
    const managed = new CancelledTagFetch({ root: own, stateDir: join(directory, "tag-fetch-state"),
      autoUpdate: false, publish() {}, activate: async (_next, persist) => persist() });
    await managed.initialize();
    const packDir = join(own, ".git", "objects", "pack");
    const checking = managed.request("check");
    const leftover = join(packDir, "tmp_pack_1");
    const deadline = Date.now() + 10_000;
    while (!existsSync(leftover)) {
      if (Date.now() > deadline) throw new Error("the tag fetch never wrote its tmp_pack_*");
      await Bun.sleep(25);
    }
    managed.controller.abort();
    await checking;
    expect(managed.fetches).toBe(1);
    expect(managed.status.error).toContain("Update cancelled");
    expect(readdirSync(packDir).filter((name) => name.startsWith("tmp_pack_"))).toHaveLength(0);
    managed.stop();
  });

  it("removes the tmp_pack_* a failed unshallow fetch left behind", async () => {
    // a failed fetch leaves its half-written pack behind however it ends, on any OS (measured on
    // git 2.54: SIGTERM, SIGINT, SIGKILL, and git's own exit after the connection dropped): the
    // failed fetch is cleaned up after (#1252).
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    managed.leaves = ["tmp_pack_new"];
    await managed.initialize();
    await managed.request("check");
    expect(managed.status.phase).toBe("error");
    expect(managed.status.error).toContain("unshallow fixture offline");
    expect(readdirSync(join(plugin, ".git", "objects", "pack"))).not.toContain("tmp_pack_new");
    managed.stop();
  });

  it("keeps a tmp_pack_* that was there before the fetch", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const packDir = join(plugin, ".git", "objects", "pack");
    writeFileSync(join(packDir, "tmp_pack_old"), "left by an earlier fetch");
    const managed = offlineUpdater(plugin);
    managed.leaves = ["tmp_pack_new"];
    await managed.initialize();
    await managed.request("check");
    expect(readdirSync(packDir)).toContain("tmp_pack_old");
    expect(readdirSync(packDir)).not.toContain("tmp_pack_new");
    managed.stop();
  });

  it("sweeps a tmp_pack_* left an hour or more ago, keeps a fresh one", async () => {
    // packs leaked before this cleanup existed (879 files, 17 GiB in #1252), or orphaned when the
    // process exited before a failed fetch's cleanup ran, are swept once stale; a fresh one may
    // still be another git's live pack (index-pack keeps touching it)
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const packDir = join(plugin, ".git", "objects", "pack");
    const stale = join(packDir, "tmp_pack_stale");
    writeFileSync(stale, "leaked long ago");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    writeFileSync(join(packDir, "tmp_pack_fresh"), "maybe still being written");
    const managed = offlineUpdater(plugin);
    managed.succeeds = true;
    await managed.initialize();
    await managed.request("check");
    expect(readdirSync(packDir)).not.toContain("tmp_pack_stale");
    expect(readdirSync(packDir)).toContain("tmp_pack_fresh");
    managed.stop();
  });

  it("leaves the pack directory alone when another git holds a lock", async () => {
    // a developer's own git pull or an IDE's auto-fetch in the same checkout: the updater's fetch
    // fails on the lock having downloaded nothing, and the tmp_pack_* that appeared meanwhile is
    // the other git's, still being written
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const packDir = join(plugin, ".git", "objects", "pack");
    const managed = offlineUpdater(plugin);
    managed.leaves = ["tmp_pack_other_git"];
    managed.failure = `git fetch --no-tags failed: fatal: Unable to create '${plugin}/.git/shallow.lock': File exists.`;
    await managed.initialize();
    await managed.request("check");
    expect(managed.status.error).toContain("File exists");
    expect(readdirSync(packDir)).toContain("tmp_pack_other_git");
    managed.failure = "git fetch --no-tags failed: error: cannot lock ref 'refs/tags/v0.1.0': is at 1 but expected 2";
    managed.leaves = ["tmp_pack_other_ref"];
    await managed.request("check", true);
    expect(managed.fetches).toBe(2);
    expect(readdirSync(packDir)).toContain("tmp_pack_other_ref");
    managed.stop();
  });

  it("touches no pack directory file but the fetch's own tmp_pack_*", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const packDir = join(plugin, ".git", "objects", "pack");
    const kept = readdirSync(packDir); // the fixture's pack-*.pack and pack-*.idx
    const managed = offlineUpdater(plugin);
    managed.leaves = ["tmp_pack_new", "pack-while-fetching.pack"];
    await managed.initialize();
    await managed.request("check");
    // a pack that arrived during the fetch, and every file older than it, stays
    expect(readdirSync(packDir)).toContain("pack-while-fetching.pack");
    for (const name of kept) expect(readdirSync(packDir)).toContain(name);
    expect(readdirSync(packDir)).not.toContain("tmp_pack_new");
    managed.stop();
  });

  it("cleans up only after a failed fetch: a successful one keeps what it wrote", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    managed.leaves = ["tmp_pack_new"];
    managed.succeeds = true;
    await managed.initialize();
    await managed.request("check");
    expect(managed.fetches).toBeGreaterThan(0);
    expect(managed.status.error).toBeNull();
    expect(readdirSync(join(plugin, ".git", "objects", "pack"))).toContain("tmp_pack_new");
    managed.stop();
  });

  it("tells the fetch's own error even when removing a leftover fails", async () => {
    await git(upstream, "tag", "v0.1.0", "HEAD");
    await commit("unreleased");
    const plugin = await shallowPlugin();
    const managed = offlineUpdater(plugin);
    // a directory cannot be removed as a file: the removal fails, the fetch's error is still the one told
    managed.leaves = ["tmp_pack_new/"];
    await managed.initialize();
    await managed.request("check");
    expect(managed.status.phase).toBe("error");
    expect(managed.status.error).toContain("unshallow fixture offline");
    managed.stop();
  });

  it("leaves the current release intact on build failure and cleans the failed stage", async () => {
    const original = updater.release;
    await release("broken build", "v0.2.0", { failBuild: true });
    await updater.request("install");
    expect(updater.status.phase).toBe("error");
    expect(updater.status.error).toContain("fixture build failure");
    // the failed step is not left standing as if it still ran
    expect(steps).toEqual([null, "download", "dependencies", "typecheck", "build", null]);
    expect(updater.release).toBe(original);
    expect(readdirSync(stateDir).filter(name => name.startsWith("release-"))).toHaveLength(0);
  });

  it("does not persist a candidate that failed startup", async () => {
    updater.options.activate = async () => { throw new Error("health check failed; previous restored"); };
    const original = updater.release;
    await release("bad startup", "v0.2.0");
    await updater.request("install");
    expect(updater.release).toBe(original);
    expect(updater.status.error).toContain("health check failed");
    expect(readdirSync(stateDir)).not.toContain("current.json");
  });

  it("automatically installs when enabled and coalesces overlapping requests", async () => {
    let activations = 0;
    updater.options.autoUpdate = true;
    updater.options.activate = async (_release: Release, persist) => { activations++; persist(); };
    const target = await release("automatic", "v0.2.0");
    await Promise.all([updater.request("check"), updater.request("install"), updater.request("check")]);
    expect(activations).toBe(1);
    expect(updater.status.current_revision).toBe(target);
  });

  it("pins accepted revision after discover", async () => {
    const target = await release("accepted", "v0.2.0");
    await updater.request("check");
    expect(updater.status.latest_revision).toBe(target);
    await updater.request("install", true, target);
    expect(updater.status).toMatchObject({ phase: "idle", error: null, error_code: null, current_revision: target });
    expect(await git(updater.release!.directory, "rev-parse", "HEAD")).toBe(target);
  });

  it("never stages a moved offer", async () => {
    const offered = await release("offered", "v0.2.0");
    let activations = 0;
    // the check an install starts with waits at its tag fetch until the test lets it go
    const reached = Promise.withResolvers<void>(), go = Promise.withResolvers<void>();
    class PausedDiscover extends Updater {
      protected async git(...args: string[]): Promise<string> {
        if (args[0] === "fetch" && args.at(-1) === "+refs/tags/v*:refs/tags/v*") { reached.resolve(); await go.promise; }
        return super.git(...args);
      }
    }
    const published: Array<typeof updater.status> = [];
    const paused = new PausedDiscover({ root, stateDir: join(directory, "paused-state"), autoUpdate: false,
      publish(status) { published.push(status); }, activate: async (_next, persist) => { activations++; persist(); } });
    await paused.initialize();
    const installing = paused.request("install", true, offered);
    await reached.promise;
    // a release published between the person's yes and the install's check
    const newer = await release("newer", "v0.3.0");
    go.resolve();
    await installing;
    expect(paused.status).toMatchObject({ phase: "error", error_code: "update_offer_changed", latest_revision: newer, latest_version: "0.3.0", available: true });
    // the new offer stays to be read; nothing was staged, built or activated
    expect(paused.notes.revision).toBe(newer);
    expect(published.some((status) => status.phase === "building" || status.step)).toBe(false);
    expect(activations).toBe(0);
    expect(paused.status.current_revision).toBe(await git(root, "rev-parse", "HEAD"));
    expect(readdirSync(join(directory, "paused-state")).filter((name) => name.startsWith("release-") || name === "failed.json")).toEqual([]);
    // and nothing tries again by itself: the error stands until someone asks
    const after = published.length;
    await Promise.resolve();
    expect(published.length).toBe(after);
    // the next check clears it, and the new offer is installed only by its own name
    await paused.request("check", true);
    expect(paused.status).toMatchObject({ phase: "idle", error: null, error_code: null, latest_revision: newer });
    paused.stop();
  });

  it("cancels an update command with a deadline", async () => {
    const start = Date.now();
    await expect(runCommand(root, [process.execPath, "--eval", "setInterval(() => {}, 1000)"], undefined, 100)).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("does not repeatedly restart into the same failed automatic update, including after restart", async () => {
    updater.options.autoUpdate = true;
    let attempts = 0;
    updater.options.activate = async () => { attempts++; throw new Error("startup failed"); };
    await release("bad automatic startup", "v0.2.0");
    await updater.request("check");
    await updater.request("check");
    expect(attempts).toBe(1);
    expect(updater.status.error).toContain("previously failed");
    const resumed = new Updater(updater.options);
    await resumed.initialize();
    await resumed.request("check");
    expect(attempts).toBe(1);
    await resumed.request("install");
    expect(attempts).toBe(2);
    resumed.stop();
  });

  // the supervisor's health check pings herdr, so this one needs a live herdr (CI has none)
  it.skipIf(!liveHerdr)("restarts the real bridge over IPC, rolls back a failed boot, and resumes the saved release", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture();
    let processHandle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      // this supervisor says over IPC that it installs only the revision it is sent
      expect((await readStatus())?.revision_bound_install).toBe(true);
      const target = await release("managed second", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return s?.current_revision === target && s.phase === "idle"; });
      expect((await readStatus())?.error).toBeNull();
      expect((await health()).web_ui.revision).toBe(target);

      writeFileSync(join(upstream, "server/index.ts"), "throw new Error('fixture startup failure');");
      await release("broken startup", "v0.3.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => (await readStatus())?.phase === "error");
      expect((await readStatus())?.current_revision).toBe(target);
      expect((await readStatus())?.error).toContain("Previous version restored");

      processHandle.kill("SIGTERM"); await processHandle.exited;
      processHandle = launch();
      await until(async () => (await readStatus())?.current_revision === target);
      expect((await readStatus())?.phase).toBe("idle");
    } catch (error) {
      await explain(error);
    } finally {
      processHandle.kill("SIGTERM");
      await processHandle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("hands over to the installed release's own supervisor", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture(releaseSupervisor());
    const marker = join(directory, "marker");
    const handle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      // the source checkout's supervisor starts first: nothing is installed yet
      expect(existsSync(marker)).toBe(false);
      const target = await release("handover", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return existsSync(marker) && s?.current_revision === target && s.phase === "idle"; });
      expect(readFileSync(marker, "utf8")).toBe("release\n");
      expect((await health()).web_ui.revision).toBe(target);
      expect((await readStatus())?.error).toBeNull();
      // asserted here and not in `finally`, where it would replace the failure that came first
      handle.kill("SIGTERM");
      expect(await handle.exited).toBe(0);
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);

  // $HOME as /home/<user> -> /data00/home/<user>: the launcher names the state dir through the link,
  // and Bun runs the installed release's supervisor from the real path (#2029)
  // only with a socket named for the test: falling back to the default one would reach the user's own herdr
  it.skipIf(!liveHerdr || !process.env["HERDR_SOCKET"])("keeps an update installed when $HOME is a symlink", async () => {
    const volume = join(directory, "volume", "home");
    mkdirSync(volume, { recursive: true });
    const home = join(directory, "home");
    symlinkSync(volume, home);
    copySupervisor(upstream);
    const { launch, readStatus, until, request, health, explain } = await managedFixture(undefined, false, home);
    let handle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      const target = await release("symlinked home", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      // "idle" with the new revision only comes from the supervisor that keeps running it: the release's own
      await until(async () => { const s = await readStatus(); return s?.current_revision === target && s.phase === "idle"; });
      expect((await health()).web_ui.revision).toBe(target);
      // and the same update is not offered again
      const checked = (await readStatus())?.checked_at ?? null;
      await request("check");
      await until(async () => { const s = await readStatus(); return (s?.checked_at ?? null) !== checked && s?.phase === "idle"; });
      expect((await readStatus())?.available).toBe(false);

      handle.kill("SIGTERM"); await handle.exited;
      handle = launch();
      await until(async () => { const s = await readStatus(); return s?.current_revision === target && s.phase === "idle"; });
      expect((await health()).web_ui.revision).toBe(target);
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 45_000);

  it.skipIf(!liveHerdr)("installs an update asked for before the bridge's first health check has passed", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture(undefined, true);
    const handle = launch();
    try {
      // the bridge reports "managed" as soon as it runs, seconds before the supervisor's start is over
      await until(async () => (await readStatus())?.managed === true);
      const target = await release("early", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => { const s = await readStatus(); return s?.current_revision === target && s.phase === "idle"; });
      expect((await readStatus())?.error).toBeNull();
      expect((await health()).web_ui.revision).toBe(target);
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("falls back to the previous supervisor when the new one cannot start", async () => {
    const { launch, readStatus, until, request, health, explain } = await managedFixture();
    const handle = launch();
    try {
      await until(async () => (await readStatus())?.managed === true);
      writeFileSync(join(upstream, "server/supervisor.ts"), releaseSupervisor(true));
      const target = await release("broken supervisor", "v0.2.0");
      await request("check");
      await until(async () => (await readStatus())?.available === true);
      await request("install");
      await until(async () => (await readStatus())?.error?.includes("previous one") === true);
      // the bridge that passed its health check keeps serving under the old supervisor
      expect((await readStatus())?.current_revision).toBe(target);
      expect((await health()).web_ui.revision).toBe(target);
      expect(handle.exitCode).toBeNull();
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);

  it.skipIf(!liveHerdr)("tells over HTTP that the checkout was replaced under the running server", async () => {
    const { launch, readStatus, until, health, explain } = await managedFixture();
    const handle = launch();
    try {
      await until(async () => /^[0-9a-f]{40}$/.test((await readStatus())?.current_revision ?? ""));
      const running = (await readStatus())?.current_revision;
      // what `herdr plugin install` or `git pull` plus a build does to a checkout that is being served
      const replaced = await commit("replaced checkout");
      await git(root, "pull", "--ff-only", "--quiet");
      // pulled, not built: the server serves the build it runs, which a reload does bring
      expect((await readStatus())?.served_revision ?? null).toBeNull();
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "build.json"), JSON.stringify({ revision: replaced }));
      // no update check: the bridge reads the build it serves when asked, not every 5 minutes
      expect((await readStatus())?.served_revision).toBe(replaced);
      // the server still runs what it started with: only a restart reports the new commit
      expect((await readStatus())?.current_revision).toBe(running!);
      expect((await health()).web_ui.revision).toBe(running!);
    } catch (error) {
      await explain(error);
    } finally {
      handle.kill("SIGTERM");
      await handle.exited;
    }
  }, 30_000);
});

describe("a command that times out or is cancelled", () => {
  // on SIGTERM git releases the lock files it holds (.git/shallow.lock among them) but leaves its
  // half-written tmp_pack_* files behind, and a SIGKILL leaves both (measured on git 2.54): asking
  // first is for the locks, and the updater sweeps the packs after a failed fetch (#1252)

  /** A child script that handles (or ignores) SIGTERM; `started` is written once the handler is in
   * place, so a signal sent after it appears cannot race the child's startup. */
  const signalChild = (name: string, handler: string, started: string, extra = "") => {
    const script = join(directory, name);
    writeFileSync(script, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { ${handler} });
writeFileSync(${JSON.stringify(started)}, "started");
${extra}
setInterval(() => {}, 1000);`);
    return script;
  };
  /** A dead process, zombies included (`ps` reports them as Z until their new parent reaps them). */
  const alive = (pid: number) => {
    try { process.kill(pid, 0); } catch { return false; }
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    return state !== "" && !state.startsWith("Z");
  };
  const awaitFile = async (file: string) => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(file)) {
      if (Date.now() > deadline) throw new Error(`${file} never appeared`);
      await Bun.sleep(25);
    }
  };

  it("is asked to end with SIGTERM, not killed outright", async () => {
    const marker = join(directory, "terminated");
    const script = signalChild("term-handler.ts",
      `writeFileSync(${JSON.stringify(marker)}, "ended"); process.exit(0);`,
      join(directory, "term-started"));
    const running = runCommand(directory, [process.execPath, script], undefined, 1_000);
    await awaitFile(join(directory, "term-started"));
    await expect(running).rejects.toThrow("timed out");
    expect(existsSync(marker)).toBe(true);
  });

  it("kills a command that ignores SIGTERM once the grace period is up", async () => {
    const pidFile = join(directory, "ignoring.pid");
    const script = signalChild("ignoring.ts", "", join(directory, "ignoring-started"),
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`);
    const running = runCommand(directory, [process.execPath, script], undefined, 1_000, 300);
    running.catch(() => {}); // a leftover child must not turn its rejection into an unhandled one
    await awaitFile(join(directory, "ignoring-started"));
    try {
      // only the SIGKILL that follows the grace period can end it, so the wait is bounded: a
      // runCommand without that kill fails here instead of hanging the whole run on the child
      const ended = await Promise.race([running.then(() => "ended", (error) => error.message), Bun.sleep(3_000).then(() => null)]);
      expect(ended).toContain("timed out");
      // dead by the SIGKILL that follows the grace period, not merely asked to die
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    } finally {
      // the child ignores SIGTERM: whatever happened above, it only ever ends by its own pid
      // a pid file caught half written reads 0, and kill(0) would end this run's whole process group
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
    }
  });

  it("kills a group member that ignores SIGTERM and outlives the command", async () => {
    // the command ends on SIGTERM, but a helper it started (same process group, none of our
    // pipes) ignores it: closing must not leave the helper running once the grace timer is gone
    const helperPid = join(directory, "helper.pid");
    const helper = signalChild("helper.ts", "", join(directory, "helper-started"),
      `writeFileSync(${JSON.stringify(helperPid)}, String(process.pid));`);
    const parent = join(directory, "parent.ts");
    writeFileSync(parent, `import { spawn } from "node:child_process";
spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(helper)}], { stdio: "ignore" }).unref();
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const running = runCommand(directory, [process.execPath, parent], controller.signal, 30_000, 60_000);
    running.catch(() => {});
    await awaitFile(join(directory, "helper-started"));
    await awaitFile(helperPid);
    const pid = Number(readFileSync(helperPid, "utf8"));
    try {
      controller.abort();
      await expect(running).rejects.toThrow("Update cancelled");
      // the grace period is a minute: only the kill on close can end the helper this soon
      const deadline = Date.now() + 5_000;
      while (alive(pid)) {
        if (Date.now() > deadline) throw new Error("the helper outlived the command");
        await Bun.sleep(25);
      }
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  });

  it("asks a cancelled command to end with SIGTERM too", async () => {
    const marker = join(directory, "cancelled");
    const script = signalChild("cancel-handler.ts",
      `writeFileSync(${JSON.stringify(marker)}, "ended"); process.exit(0);`,
      join(directory, "cancel-started"));
    const controller = new AbortController();
    const running = runCommand(directory, [process.execPath, script], controller.signal, 30_000);
    await awaitFile(join(directory, "cancel-started"));
    controller.abort();
    await expect(running).rejects.toThrow("Update cancelled");
    expect(existsSync(marker)).toBe(true);
  });
});

describe("a release's notes file", () => {
  it("is read whole within its limit, from one descriptor, and only as a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-notes-file-"));
    try {
      writeFileSync(join(dir, "small.md"), "## [0.1.0]\n- one\n");
      expect(readNotesFile(join(dir, "small.md"))).toBe("## [0.1.0]\n- one\n");
      writeFileSync(join(dir, "large.md"), Buffer.alloc(NOTES_FILE_LIMIT + 1, 0x78));
      expect(() => readNotesFile(join(dir, "large.md"))).toThrow(/not notes|too large/);
      // a symlink is not followed: the release's own file is what is read, not where a link points
      symlinkSync(join(dir, "small.md"), join(dir, "link.md"));
      expect(() => readNotesFile(join(dir, "link.md"))).toThrow();
      // a FIFO would hold the supervisor's synchronous read for a writer that never comes
      if (spawnSync("mkfifo", [join(dir, "fifo.md")]).status === 0) expect(() => readNotesFile(join(dir, "fifo.md"))).toThrow(/not notes/);
      expect(() => readNotesFile(join(dir, "missing.md"))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("update channels", () => {
  it("orders releases after their betas and betas by number, and keeps betas off stable", () => {
    const tags = ["v0.4.22", "beta/v0.4.23-beta.9", "beta/v0.4.23-beta.10", "v0.4.24-beta.1", "remote-v9", "v1.0.0-rc1", ""];
    expect(latestTag(tags, "stable")).toBe("v0.4.22");
    expect(latestTag(tags, "beta")).toBe("beta/v0.4.23-beta.10");
    expect(latestTag([...tags, "v0.4.23"], "beta")).toBe("v0.4.23");
    expect(latestTag(["beta/v0.4.23-beta.2"], "stable")).toBeUndefined();
  });

  it("reads the channel from OVIS_UPDATE_CHANNEL first, then the state dir's file, else stable", () => {
    const appState = mkdtempSync(join(tmpdir(), "ovis-channel-"));
    try {
      expect(updateChannel({}, appState)).toBe("stable");
      writeFileSync(join(appState, UPDATE_CHANNEL_FILE), " Beta\n");
      expect(updateChannel({}, appState)).toBe("beta");
      expect(updateChannel({ OVIS_UPDATE_CHANNEL: "stable" }, appState)).toBe("stable");
      writeFileSync(join(appState, UPDATE_CHANNEL_FILE), "nightly");
      expect(updateChannel({}, appState)).toBe("stable");
      expect(updateChannel({ OVIS_UPDATE_CHANNEL: "beta" }, appState)).toBe("beta");
    } finally { rmSync(appState, { recursive: true, force: true }); }
  });
});

it("cancels an install while it builds: nothing is installed, its offer stays, and it is not taken for a failed release", async () => {
  const running = updater.status.current_revision;
  // a release whose build never ends on its own
  writeFileSync(join(upstream, "build-fixture.ts"), "await new Promise(() => {});");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-qm", "slow build");
  await git(upstream, "tag", "v9.0.0");
  const building = Promise.withResolvers<void>();
  const watched = new Updater({ ...updater.options, publish(status) { if (status.step === "build") building.resolve(); } });
  await watched.initialize();
  try {
    // nothing to cancel before an install runs
    expect(watched.cancel("11111111-2222-4333-8444-555555555555")).toBe(false);
    const install = watched.request("install", true, undefined, "11111111-2222-4333-8444-555555555555");
    await building.promise;
    // another's id (another device's install, or this PC's own Settings') never stops it
    expect(watched.cancel("99999999-2222-4333-8444-555555555555")).toBe(false);
    expect(watched.cancel("11111111-2222-4333-8444-555555555555")).toBe(true);
    await install;
    expect(watched.status).toMatchObject({ phase: "error", error_code: "update_cancelled", current_revision: running, available: true, install_cancellable: true });
    expect(existsSync(join(stateDir, "failed.json"))).toBe(false);
    // the 5-minute timer's check (auto-update on) leaves the cancelled release alone: it would build it again otherwise
    (watched.options as { autoUpdate: boolean }).autoUpdate = true;
    await watched.request("check");
    expect(watched.status.phase).toBe("idle");
    expect(watched.status.current_revision).toBe(running);
  } finally { watched.stop(); }
});

it("stops an install cancelled while it still checks what is on offer, before anything is built", async () => {
  writeFileSync(join(upstream, "build-fixture.ts"), "await new Promise(() => {});");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-qm", "slow build");
  await git(upstream, "tag", "v9.0.1");
  const seen: Array<string | null> = [];
  const watched: Updater = new Updater({ ...updater.options, publish(status) {
    seen.push(status.step ?? null);
    // asked as soon as the run starts checking
    if (status.phase === "checking" && !asked) asked = watched.cancel("11111111-2222-4333-8444-555555555555");
  } });
  let asked = false;
  await watched.initialize();
  try {
    await watched.request("install", true, undefined, "11111111-2222-4333-8444-555555555555");
    expect(asked).toBe(true);
    expect(watched.status).toMatchObject({ phase: "error", error_code: "update_cancelled", available: true });
    expect(seen).not.toContain("build");
  } finally { watched.stop(); }
});
