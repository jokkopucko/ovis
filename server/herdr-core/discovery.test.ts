import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAbsolute, relative } from "node:path";
import { coreSocket, discoverHc, findHc, plainSession } from "./discovery.ts";

const unix = process.platform !== "win32";
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function scratch(): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "ovis-hc-discovery-"));
  cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, log: join(root, "argv.log") };
}

/** a stand-in executable that logs every argument list it is run with, then says `output` */
function fake(dir: string, name: string, output: string, log: string, exit = 0): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '${output}'\nexit ${exit}\n`, { mode: 0o755 });
  return path;
}

/** a stand-in whose whole script is `body`, logging its argument lists */
function script(dir: string, name: string, body: string, log: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  return path;
}

function runs(log: string): string[] {
  try { return readFileSync(log, "utf8").split("\n").filter((line) => line !== ""); } catch { return []; }
}

it.skipIf(!unix)("looks where the Herdr app does: OVIS_HC_BIN, the PATH, the login shell's PATH, then the usual places", async () => {
  const { root, log } = scratch();
  const named = fake(join(root, "named"), "my-hc", "hc 0.1.20", log);
  const onPath = fake(join(root, "path"), "hc", "hc 0.1.19", log);
  const onLogin = fake(join(root, "login"), "hc", "hc 0.1.18", log);
  const usual = fake(join(root, "usual"), "hc", "hc 0.1.17", log);
  const options = (env: Record<string, string>, login: string | null) => ({
    env, home: root, loginShellPath: async () => login, usualDirs: [join(root, "usual")],
  });
  expect(await findHc(options({ OVIS_HC_BIN: named, PATH: join(root, "path") }, join(root, "login")))).toEqual({ bin: named, version: "0.1.20" });
  expect(await findHc(options({ PATH: join(root, "path") }, join(root, "login")))).toEqual({ bin: onPath, version: "0.1.19" });
  expect(await findHc(options({ PATH: join(root, "empty") }, join(root, "login")))).toEqual({ bin: onLogin, version: "0.1.18" });
  expect(await findHc(options({ PATH: join(root, "empty") }, null))).toEqual({ bin: usual, version: "0.1.17" });
  expect(await findHc(options({ PATH: join(root, "empty") }, join(root, "empty")))).toEqual({ bin: usual, version: "0.1.17" });
});

it.skipIf(!unix)("takes herdr-core before hc in the same folder, as the app does", async () => {
  const { root, log } = scratch();
  fake(join(root, "bin"), "hc", "hc 0.1.17", log);
  const core = fake(join(root, "bin"), "herdr-core", "hc 0.1.17", log);
  expect(await findHc({ env: { PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [] })).toEqual({ bin: core, version: "0.1.17" });
});

it.skipIf(!unix)("passes over an hc that is not herdr-core's, and one that fails, for the next candidate", async () => {
  const { root, log } = scratch();
  fake(join(root, "wm"), "hc", "herbstclient 0.9.5", log);
  fake(join(root, "broken"), "hc", "hc 0.1.17", log, 1);
  const named = fake(join(root, "named"), "hc", "hcx 2", log);
  const real = fake(join(root, "login"), "hc", "hc 0.1.17", log);
  const found = await findHc({
    env: { OVIS_HC_BIN: named, PATH: [join(root, "wm"), join(root, "broken")].join(":") },
    home: root, loginShellPath: async () => join(root, "login"), usualDirs: [],
  });
  expect(found).toEqual({ bin: real, version: "0.1.17" });
  // nothing that answers otherwise is ever taken
  expect(await findHc({ env: { PATH: join(root, "wm") }, home: root, loginShellPath: async () => null, usualDirs: [] })).toBeNull();
});

it.skipIf(!unix)("never runs any hc command but --version: any other one can start a core", async () => {
  const { root, log } = scratch();
  fake(join(root, "wm"), "hc", "herbstclient 0.9.5", log);
  fake(join(root, "path"), "herdr-core", "hc 0.1.17", log);
  fake(join(root, "path"), "hc", "hc 0.1.17", log);
  await findHc({ env: { PATH: [join(root, "wm"), join(root, "path")].join(":") }, home: root, loginShellPath: async () => null, usualDirs: [] });
  await findHc({ env: { PATH: join(root, "wm") }, home: root, loginShellPath: async () => join(root, "path"), usualDirs: [join(root, "path")] });
  expect(runs(log).length).toBeGreaterThan(0);
  expect(new Set(runs(log))).toEqual(new Set(["--version"]));
});

it("finds the core's socket the way hc does, and calls it running only when the file is there", () => {
  const { root } = scratch();
  const home = join(root, "home");
  const run = join(root, "run");
  const base = { home, platform: "linux" as NodeJS.Platform, userRuntimeDir: null };
  // the session: HC_SESSION without spaces around it, else default
  expect(coreSocket({ ...base, env: { XDG_RUNTIME_DIR: run, HC_SESSION: " work " } })).toEqual({ session: "work", path: join(run, "herdr-core", "work.sock"), running: false });
  // no runtime dir from the environment: /run/user/<uid> when it exists, else beside the state
  expect(coreSocket({ ...base, env: {}, userRuntimeDir: run }).path).toBe(join(run, "herdr-core", "default.sock"));
  expect(coreSocket({ ...base, env: {} }).path).toBe(join(home, ".local", "state", "herdr-core", "default", "default.sock"));
  expect(coreSocket({ ...base, env: { XDG_STATE_HOME: join(root, "state"), HC_SESSION: "" } }).path).toBe(join(root, "state", "herdr-core", "default", "default.sock"));
  // `socket` in hc's config, then HC_SOCKET, win over the runtime dir
  const config = join(root, "config");
  mkdirSync(join(config, "herdr-core"), { recursive: true });
  writeFileSync(join(config, "herdr-core", "config.toml"), `# hc\nsocket = "${join(root, "configured.sock")}"\n`);
  expect(coreSocket({ ...base, env: { XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: run } }).path).toBe(join(root, "configured.sock"));
  const chosen = join(root, "chosen.sock");
  writeFileSync(chosen, "");
  expect(coreSocket({ ...base, env: { HC_SOCKET: chosen, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: run } })).toEqual({ session: "default", path: chosen, running: true });
});

it.skipIf(!unix)("takes only output that starts with hc and a version, never a path or junk after a blank line", async () => {
  const { root, log } = scratch();
  const look = (dir: string) => findHc({ env: { PATH: join(root, dir) }, home: root, loginShellPath: async () => null, usualDirs: [] });
  script(join(root, "blank"), "hc", "printf '\\nhc 0.1.17\\n'", log);
  script(join(root, "path"), "hc", "printf 'hc /home/someone/bin\\n'", log);
  script(join(root, "real"), "hc", "printf 'hc 0.1.17-rc.1\\n'", log);
  expect(await look("blank")).toBeNull();
  expect(await look("path")).toBeNull();
  expect((await look("real"))?.version).toBe("0.1.17-rc.1");
});

it.skipIf(!unix)("looks a bare OVIS_HC_BIN up on the PATH, before anything else there", async () => {
  const { root, log } = scratch();
  fake(join(root, "bin"), "herdr-core", "hc 0.1.16", log);
  const named = fake(join(root, "bin"), "my-hc", "hc 0.1.17", log);
  expect(await findHc({ env: { OVIS_HC_BIN: "my-hc", PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [] })).toEqual({ bin: named, version: "0.1.17" });
});

it.skipIf(!unix)("does not wait on what a candidate left holding its output, and kills it", async () => {
  const { root, log } = scratch();
  const pidFile = join(root, "left.pid");
  script(join(root, "bin"), "hc", `/bin/sleep 30 & echo $! > '${pidFile}'\nprintf 'hc 0.1.17\\n'`, log);
  const found = await findHc({ env: { PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [], timeoutMs: 10_000 });
  expect(found?.version).toBe("0.1.17");
  const left = Number(readFileSync(pidFile, "utf8"));
  // the group was killed once the answer was in: signalling the leftover now finds nothing
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt++) {
    try { process.kill(left, 0); await Bun.sleep(20); } catch { alive = false; }
  }
  expect(alive).toBe(false);
});

it.skipIf(!unix)("passes over a candidate that does not answer in time", async () => {
  const { root, log } = scratch();
  script(join(root, "slow"), "hc", "exec /bin/sleep 30", log);
  const real = fake(join(root, "real"), "hc", "hc 0.1.17", log);
  expect(await findHc({ env: { PATH: [join(root, "slow"), join(root, "real")].join(":") }, home: root, loginShellPath: async () => null, usualDirs: [], timeoutMs: 200 })).toEqual({ bin: real, version: "0.1.17" });
});

it.skipIf(!unix)("waits for a candidate that closed its output to exit, within the time it is given", async () => {
  const { root, log } = scratch();
  const slow = script(join(root, "bin"), "hc", "printf 'hc 0.1.17\\n'\nexec 1>&-\n/bin/sleep 1", log);
  expect(await findHc({ env: { PATH: join(root, "bin") }, home: root, loginShellPath: async () => null, usualDirs: [], timeoutMs: 5_000 })).toEqual({ bin: slow, version: "0.1.17" });
});

it("reads the configured socket as TOML, escapes and all", () => {
  const { root } = scratch();
  const config = join(root, "config");
  mkdirSync(join(config, "herdr-core"), { recursive: true });
  writeFileSync(join(config, "herdr-core", "config.toml"), `socket = "${join(root, "core")}\\u002Dsock"\n[other]\nsocket = "no"\n`);
  expect(coreSocket({ env: { XDG_CONFIG_HOME: config }, home: root, platform: "linux", userRuntimeDir: null }).path).toBe(join(root, "core-sock"));
});

it("tells a session only when it is a plain name, as hc takes one", () => {
  expect(plainSession("default")).toBe("default");
  expect(plainSession("work.2_a-b")).toBe("work.2_a-b");
  for (const name of ["/home/someone/private", "a\\b", "..", ".", "a b", ""]) expect(plainSession(name)).toBeNull();
});

it.skipIf(!unix)("looks for the Settings facts without running the login shell: its profile could start a core", async () => {
  const { root, log } = scratch();
  const shell = script(join(root, "shell"), "sh", "printf 'login\\n' >> '" + join(root, "shell.log") + "'", log);
  const core = fake(join(root, "bin"), "herdr-core", "hc 0.1.17", log);
  expect(await discoverHc({ env: { SHELL: shell, PATH: join(root, "empty") }, home: root, usualDirs: [join(root, "bin")] })).toEqual({ bin: core, version: "0.1.17" });
  expect(runs(join(root, "shell.log"))).toEqual([]);
});

it.skipIf(!unix)("answers the hc it found as an absolute path, whatever folder the server runs in", async () => {
  const { root, log } = scratch();
  fake(join(root, "bin"), "hc", "hc 0.1.17", log);
  const found = await findHc({ env: { PATH: relative(process.cwd(), join(root, "bin")) }, home: root, loginShellPath: async () => null, usualDirs: [] });
  expect(found?.bin).toBe(join(root, "bin", "hc"));
  expect(isAbsolute(found!.bin)).toBe(true);
});

it("takes no socket from a config.toml too big to be a config, so a health poll never reads it whole", () => {
  const { root } = scratch();
  const config = join(root, "config");
  mkdirSync(join(config, "herdr-core"), { recursive: true });
  writeFileSync(join(config, "herdr-core", "config.toml"), `socket = "${join(root, "configured.sock")}"\n# ${"x".repeat(2 * 1024 * 1024)}\n`);
  expect(coreSocket({ env: { XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: join(root, "run") }, home: root, platform: "linux", userRuntimeDir: null }).path).toBe(join(root, "run", "herdr-core", "default.sock"));
});
