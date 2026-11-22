import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyEnv, mergeEnvLayers, ovisName, withLegacyNames } from "./legacy-env.ts";
import { updateStateDir } from "./update-state.ts";

describe("settings under their names from before the rename", () => {
  it("fill an unset OVIS_* variable", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", HERDR_WEB_UI_REF: "v1.2.3", HERDR_SOCKET: "/s" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("old");
    expect(env["OVIS_REF"]).toBe("v1.2.3");
    expect(Object.keys(env).filter((name) => name.startsWith("OVIS_")).sort()).toEqual(["OVIS_REF", "OVIS_TOKEN"]);
  });

  it("never override a variable set under the new name", () => {
    const env: Record<string, string | undefined> = { HERDR_WEB_TOKEN: "old", OVIS_TOKEN: "new" };
    adoptLegacyEnv(env);
    expect(env["OVIS_TOKEN"]).toBe("new");
  });

  it("map only the app's own prefix", () => {
    expect(ovisName("HERDR_WEB_STATE_DIR")).toBe("OVIS_STATE_DIR");
    expect(ovisName("HERDR_TEST_SESSION")).toBeNull();
  });

  it("are handed back to a bridge from before the rename", () => {
    expect(withLegacyNames({ OVIS_BOOT_ID: "b", OVIS_REF: "v1", HERDR_SOCKET: "/s" }))
      .toEqual({ OVIS_BOOT_ID: "b", HERDR_WEB_BOOT_ID: "b", OVIS_REF: "v1", HERDR_WEB_UI_REF: "v1", HERDR_SOCKET: "/s" });
  });

  it("let a settings file's old name win over the parent's, as the file always did", () => {
    const merged = mergeEnvLayers([{ HERDR_WEB_TOKEN: "first" }, { HERDR_WEB_TOKEN: "changed" }]);
    expect(merged["OVIS_TOKEN"]).toBe("changed");
    expect(mergeEnvLayers([{ OVIS_TOKEN: "parent" }, { HERDR_WEB_TOKEN: "file" }])["OVIS_TOKEN"]).toBe("file");
    expect(mergeEnvLayers([{ HERDR_WEB_TOKEN: "parent" }, { OVIS_TOKEN: "file" }])["OVIS_TOKEN"]).toBe("file");
  });
});

describe("a supervisor started by the launcher of an install from before the rename", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const git = (cwd: string, ...args: string[]): string => {
    const run = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Ovis test", ...args], { cwd, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const port = 59_997;

  function installedRelease() {
    const directory = mkdtempSync(join(tmpdir(), "ovis-legacy-launcher-"));
    roots.push(directory);
    const root = join(directory, "checkout"), config = join(directory, "config");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "legacy-launcher-fixture", version: "0.4.13" }));
    git(root, "add", ".");
    git(root, "commit", "-qm", "0.4.13");
    const updates = updateStateDir(root, port, join(config, "herdr-web-ui"));
    const release = join(updates, "release-next");
    mkdirSync(updates, { recursive: true });
    git(directory, "clone", "-q", root, release);
    git(release, "commit", "-q", "--allow-empty", "-m", "next");
    writeFileSync(join(updates, "current.json"), JSON.stringify({ directory: release,
      revision: git(release, "rev-parse", "HEAD"), source_revision: git(root, "rev-parse", "HEAD") }));
    return { directory, root, config, release };
  }

  type Launch = { cwd: string; stateDir: string; managed: string; revision: string };
  async function startBridge(directory: string, config: string, launcherEnv: Record<string, string>, failing = false, afterStart = "process.exit(0);"): Promise<Launch[]> {
    const record = join(directory, "bridge.json");
    const script = join(directory, "supervisor-stand-in.ts");
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      const realSpawn = Bun.spawn;
      const launches = [];
      let bootId = "";
      Bun.spawn = ((argv, options) => {
        if (argv[1] !== "server/index.ts") return realSpawn(argv, options);
        const old = options.cwd === process.env.HERDR_WEB_SOURCE_ROOT;
        const read = (name) => options.env[old ? name.replace("OVIS_", "HERDR_WEB_") : name];
        launches.push({ cwd: options.cwd, stateDir: read("OVIS_STATE_DIR"), managed: read("OVIS_MANAGED"), revision: read("OVIS_REVISION") });
        writeFileSync(${JSON.stringify(record)}, JSON.stringify(launches));
        if (${failing} && !old) return { exitCode: 1, kill() {}, exited: Promise.resolve(1), send() {} };
        // a bridge told another boot id never passes the health check: the supervisor would wait
        // its whole deadline out and then fail
        if (read("OVIS_BOOT_ID") !== options.env.OVIS_BOOT_ID) {
          console.error(\`the bridge in \${options.cwd} cannot answer the boot id it was given\`);
          process.exit(3);
        }
        bootId = options.env.OVIS_BOOT_ID;
        return { exitCode: null, kill() {}, exited: Promise.resolve(0), send() {} };
      }) as typeof Bun.spawn;
      globalThis.fetch = (async () => ({ ok: true, json: async () => ({ web_ui: { boot_id: bootId } }) })) as unknown as typeof fetch;
      const { runSupervisor } = await import(${JSON.stringify(join(import.meta.dir, "supervisor.ts"))});
      await runSupervisor(process.env.OVIS_SOURCE_ROOT);
      ${afterStart}
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OVIS_") && !name.startsWith("HERDR_WEB_")));
    const child = Bun.spawn([process.execPath, script], { env: { ...env, ...launcherEnv, XDG_CONFIG_HOME: config,
      PORT: String(port), HOST: "127.0.0.1", HERDR_SOCKET: join(directory, "herdr.sock"), OVIS_AUTO_UPDATE: "0" },
    stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const code = await child.exited;
      if (code !== 0 || !existsSync(record)) throw new Error(`the supervisor exited ${code}:\n${(await output).join("\n")}`);
      return JSON.parse(readFileSync(record, "utf8")) as Launch[];
    } finally {
      clearTimeout(timer);
    }
  }

  it("runs the release it installed and keeps the state where that launcher looks", async () => {
    // the v0.4.13 launcher names the checkout HERDR_WEB_SOURCE_ROOT, and it finds the active
    // release, at every start and every handover after the next install, only under the old
    // state dir: moved away, the update came back as the source checkout's old version
    const { directory, root, config, release } = installedRelease();
    const [bridge, ...more] = await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root });
    expect(more).toEqual([]);
    expect(bridge!.cwd).toBe(release);
    expect(bridge!.stateDir).toBe(join(config, "herdr-web-ui"));
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
  }, 20_000);

  it("falls back from a release that fails to the 0.4.13 checkout, telling its bridge what it reads", async () => {
    // after a second update, the 0.4.13 launcher's own fallback is the previous release's
    // supervisor, which starts the source checkout the same way: a bridge that cannot answer
    // the boot id or is not told it is managed leaves the app down or unable to update
    const { directory, root, config, release } = installedRelease();
    const launches = await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root }, true);
    expect(launches.map((launch) => launch.cwd)).toEqual([release, root]);
    expect(launches[1]).toEqual({ cwd: root, stateDir: join(config, "herdr-web-ui"), managed: "1", revision: git(root, "rev-parse", "HEAD") });
  }, 20_000);

  function standInInstall(directory: string, release: string, body = ""): void {
    mkdirSync(join(release, "scripts"), { recursive: true });
    writeFileSync(join(release, "scripts", "pty-sidecar.ts"), `
      import { renameSync, writeFileSync } from "node:fs";
      const record = ${JSON.stringify(directory)} + "/install-" + process.pid + ".json";
      writeFileSync(record + ".tmp", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
      renameSync(record + ".tmp", record);
      ${body}
    `);
  }
  const installs = (directory: string) => readdirSync(directory).filter((name) => name.startsWith("install-") && name.endsWith(".json"));
  function seen(directory: string, check: () => boolean, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(new Error(`${what} never happened`)); }, 15_000);
      const look = () => {
        if (!check()) return;
        watcher.close();
        clearTimeout(timer);
        resolve();
      };
      const watcher = watch(directory, look);
      look();
    });
  }

  it.skipIf(process.platform === "win32")("fetches the Rust PTY host that the 0.4.13 updater left out of the release", async () => {
    // 0.4.13's updater builds a release without scripts/pty-sidecar.ts install, so the release came
    // up without its Rust PTY host: its terminals ran on Node, or were mirrored on a PC without Node
    const { directory, root, config, release } = installedRelease();
    standInInstall(directory, release);
    const installed = seen(directory, () => installs(directory).length > 0, "the release's Rust PTY host install");
    await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root });
    await installed;
    const [record, ...more] = installs(directory);
    expect(more).toEqual([]);
    expect(JSON.parse(readFileSync(join(directory, record!), "utf8"))).toEqual({ cwd: realpathSync(release), args: ["install"] });
  }, 30_000);

  it.skipIf(process.platform === "win32")("tries the Rust PTY host again only after its retry wait", async () => {
    const { directory, root, config, release } = installedRelease();
    standInInstall(directory, release);
    const first = seen(directory, () => installs(directory).length === 1, "the first install");
    await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root });
    await first;
    const attempt = join(release, "bin", "ovis-pty-sidecar.attempt");
    writeFileSync(attempt, "kept\n");
    await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root });
    expect(readFileSync(attempt, "utf8")).toBe("kept\n");
    expect(installs(directory)).toHaveLength(1);
    const past = Date.now() / 1000 - 7 * 60 * 60;
    utimesSync(attempt, past, past);
    const second = seen(directory, () => installs(directory).length === 2, "the install after the retry wait");
    await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root });
    await second;
    expect(readFileSync(attempt, "utf8")).not.toBe("kept\n");
  }, 40_000);

  it.skipIf(process.platform === "win32")("stops its Rust PTY host install when the supervisor stops", async () => {
    // the install runs in a process group of its own: left running, it would outlive the
    // supervisor and its 120 s limit, and could meet the next supervisor's try in bin/
    const { directory, root, config, release } = installedRelease();
    const started = join(directory, "install-started"), stopped = join(directory, "install-stopped");
    standInInstall(directory, release, `
      process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(stopped)}, ""); process.exit(0); });
      writeFileSync(${JSON.stringify(started)}, "");
      setInterval(() => {}, 60_000);
    `);
    const stop = seen(directory, () => existsSync(stopped), "the install's stop");
    await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root }, false, `
      const { existsSync, watch } = await import("node:fs");
      await new Promise((resolve) => {
        const look = () => { if (existsSync(${JSON.stringify(started)})) { watcher.close(); resolve(); } };
        const watcher = watch(${JSON.stringify(directory)}, look);
        look();
      });
      process.kill(process.pid, "SIGTERM");
      setInterval(() => {}, 60_000);
    `);
    await stop;
  }, 30_000);

  it.skipIf(process.platform === "win32")("kills a Rust PTY host install that ignores SIGTERM, and its children, before the supervisor exits", async () => {
    // an install and a child of it that ignore SIGTERM must not outlive the supervisor: left alive,
    // the next supervisor's try after the retry wait would meet them in bin/
    const { directory, root, config, release } = installedRelease();
    const started = join(directory, "install-started"), pids = join(directory, "install-pids");
    // both hold the write end of this FIFO: its reader sees the end only once both are gone
    const fifo = join(directory, "install-alive");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const reader = createReadStream(fifo);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("the install or its child outlived the supervisor")), 15_000);
      reader.on("data", () => undefined);
      reader.on("end", () => { clearTimeout(timer); resolve(); });
      reader.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    gone.catch(() => undefined); // awaited below; a run that fails before then must not leave it unhandled
    standInInstall(directory, release, `
      const { openSync } = await import("node:fs");
      const { spawn } = await import("node:child_process");
      process.on("SIGTERM", () => {});
      const alive = openSync(${JSON.stringify(fifo)}, "w");
      // the child says it started only once it ignores SIGTERM itself, so the stop meets both handlers
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], ''); setInterval(() => {}, 60_000);", ${JSON.stringify(started)}], { stdio: ["ignore", "ignore", "ignore", alive] });
      writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 60_000);
    `);
    try {
      await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root }, false, `
        const { existsSync, watch } = await import("node:fs");
        await new Promise((resolve) => {
          const look = () => { if (existsSync(${JSON.stringify(started)})) { watcher.close(); resolve(); } };
          const watcher = watch(${JSON.stringify(directory)}, look);
          look();
        });
        process.kill(process.pid, "SIGTERM");
        setInterval(() => {}, 60_000);
      `);
      await gone;
    } finally {
      if (existsSync(pids)) for (const pid of JSON.parse(readFileSync(pids, "utf8")) as number[]) { try { process.kill(pid, "SIGKILL"); } catch {} }
      clearTimeout(timer);
      // a reader still waiting for its first writer is let go by a writer that opens and leaves at once
      try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch {}
      reader.destroy();
    }
  }, 40_000);

  it.skipIf(process.platform === "win32")("exits even when a process of its Rust PTY host install escaped the group and holds its output open", async () => {
    // a descendant in a group of its own outlives the group's SIGKILL and keeps the install's
    // stdout open, so the install never closes: the stop is bounded, or the plugin could never
    // start the supervisor again
    const { directory, root, config, release } = installedRelease();
    const started = join(directory, "install-started"), pids = join(directory, "install-pids");
    standInInstall(directory, release, `
      const { spawn } = await import("node:child_process");
      process.on("SIGTERM", () => {});
      // the escaped child says it started only once it ignores SIGTERM itself
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], ''); setInterval(() => {}, 60_000);", ${JSON.stringify(started)}], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
      writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 60_000);
    `);
    try {
      await startBridge(directory, config, { HERDR_WEB_SOURCE_ROOT: root }, false, `
        const { existsSync, watch } = await import("node:fs");
        await new Promise((resolve) => {
          const look = () => { if (existsSync(${JSON.stringify(started)})) { watcher.close(); resolve(); } };
          const watcher = watch(${JSON.stringify(directory)}, look);
          look();
        });
        process.kill(process.pid, "SIGTERM");
        setInterval(() => {}, 60_000);
      `);
    } finally {
      if (existsSync(pids)) for (const pid of JSON.parse(readFileSync(pids, "utf8")) as number[]) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }, 40_000);

  it("moves the state dir once a launcher of this version starts it", async () => {
    const { directory, root, config } = installedRelease();
    const [bridge] = await startBridge(directory, config, { OVIS_SOURCE_ROOT: root, OVIS_LAUNCHER: "1" });
    expect(bridge!.stateDir).toBe(join(config, "ovis"));
    expect(lstatSync(join(config, "herdr-web-ui")).isSymbolicLink()).toBe(true);
  }, 20_000);
});
