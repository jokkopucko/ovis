import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { platform, tmpdir, uptime } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { COMMAND_ALIASES } from "./plugin-runtime.ts";
import { herdrStateDir } from "./plugin-state.ts";
import { savedPort } from "./plugin-port.ts";
import { mergeEnvLayers } from "../server/legacy-env.ts";
import { quietPort, REAL_PORTS } from "./quiet-port.ts";
import { readProcessBirth } from "../server/process-owner.ts";
import { updateStateDir } from "../server/update-state.ts";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { trustRefusal } from "../server/herdr-core/discovery.ts";
import { profileGroups } from "../server/herdr-discovery.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import { newInvite } from "../shared/account-list-join.ts";

const ROOT = join(import.meta.dir, "..");
let scratch: string;
let configDir: string;

async function status(): Promise<{ out: string; err: string; exitCode: number }> {
  return run("status");
}

async function run(command: string, extra: Record<string, string | undefined> = {}, more: { args?: string[]; stdin?: string; timeout?: number; preload?: string } = {}): Promise<{ out: string; err: string; exitCode: number }> {
  const child = launch(command, extra, more);
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, exitCode };
}

/** Preloaded into each command and the Bun processes it starts: stops them at a real port (scripts/real-ports-guard.ts). */
const GUARD = join(import.meta.dir, "real-ports-guard.ts");

/** KEY=VALUE lines, as scripts/plugin.ts reads its settings files. */
const settingsIn = (file: string): Record<string, string> => !existsSync(file) ? {} : Object.fromEntries(readFileSync(file, "utf8").split("\n")
  .map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#") && line.indexOf("=") > 0)
  .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));

/**
 * The port a command run with `env` opens and asks, found the way scripts/plugin.ts finds it: PORT from its environment
 * and then its settings files, which win, and the kept port when that leaves none. null when it would fall back to
 * DEFAULT_PORT.
 */
function portFor(env: Record<string, string | undefined>): string | null {
  const dir = env["HERDR_PLUGIN_CONFIG_DIR"] ?? configDir;
  const merged = mergeEnvLayers([env, ...["env", ".env"].map((name) => settingsIn(join(dir, name)))]);
  if ((merged["PORT"] ?? "") !== "") return merged["PORT"]!;
  const config = merged["XDG_CONFIG_HOME"] || join(scratch, ".config");
  const kept = savedPort(join(merged["OVIS_STATE_DIR"] || join(config, "ovis"), "plugin-port")) ?? savedPort(join(config, "herdr-web-ui", "plugin-port"));
  return kept === null ? null : String(kept);
}

/**
 * A server on a port the system hands out (port 0), but never one of REAL_PORTS: the system's range holds two of them
 * (37317 and 47317), and launchEnv refuses to hand those to a command. A server that lands on one is held while the
 * next is taken, so the next cannot land there again; then it is let go.
 */
function offRealPorts<T extends { port?: number; stop(closeActiveConnections?: boolean): unknown }>(start: () => T): T {
  const held: T[] = [];
  let server = start();
  while (REAL_PORTS.includes(Number(server.port))) {
    held.push(server);
    server = start();
  }
  for (const extra of held) void extra.stop(true);
  return server;
}
const serveOffRealPorts = ((options: Parameters<typeof Bun.serve>[0]) => offRealPorts(() => Bun.serve(options))) as typeof Bun.serve;

/**
 * The command's environment. PORT is a quiet port unless `extra` names it: with none, the command would ask DEFAULT_PORT
 * (7317), where this PC's own Ovis answers. A test of the port a command finds without PORT passes `PORT: undefined`
 * and keeps a port first (`keep`), which the command then reads. Refused when the port the command would use, after
 * its settings files, is one this PC's own Ovis may be on.
 */
function launchEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const bin = join(scratch, "bin");
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: scratch, HERDR_PLUGIN_STATE_DIR: join(scratch, "state") };
  for (const key of ["HERDR_PLUGIN_CONFIG_DIR", "PORT", "HOST", "OVIS_TOKEN", "OVIS_STATE_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]) delete env[key];
  if (!("PORT" in extra)) env["PORT"] = String(quietPort());
  env["BUN_OPTIONS"] = `${process.env["BUN_OPTIONS"] ?? ""} --preload ${GUARD}`.trim();
  env["OVIS_TEST_REAL_PORTS_LOG"] = join(scratch, "real-ports.log");
  Object.assign(env, extra);
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  const port = portFor(env);
  if (port === null) throw new Error("a test leaves PORT out with no port kept: the command would ask 7317, where this PC's own Ovis answers");
  if (REAL_PORTS.includes(Number(port))) throw new Error(`a test hands the command PORT=${port}, a port this PC's own Ovis may be on`);
  return env;
}

function launch(command: string, extra: Record<string, string | undefined> = {}, more: { args?: string[]; stdin?: string; timeout?: number; preload?: string } = {}) {
  return Bun.spawn(["bun", ...more.preload === undefined ? [] : ["--preload", more.preload], "scripts/plugin.ts", command, ...more.args ?? []], { cwd: ROOT, env: launchEnv(extra), stdout: "pipe", stderr: "pipe", ...more.stdin === undefined ? {} : { stdin: new Blob([more.stdin]) }, ...more.timeout === undefined ? {} : { timeout: more.timeout, killSignal: "SIGKILL" } });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "herdr-plugin-env-"));
  configDir = join(scratch, "config");
  mkdirSync(configDir);
  mkdirSync(join(scratch, "bin"));
  const herdr = join(scratch, "bin", "herdr");
  writeFileSync(herdr, `#!/bin/sh\n[ "$1 $2" = "plugin config-dir" ] && echo "${configDir}"\n`);
  chmodSync(herdr, 0o755);
});

afterEach(() => {
  const reached = existsSync(join(scratch, "real-ports.log")) ? readFileSync(join(scratch, "real-ports.log"), "utf8") : "";
  rmSync(scratch, { recursive: true, force: true });
  expect(reached, "a command went for a port this PC's own Ovis may be on, and the guard stopped it").toBe("");
});

describe("the launch helper", () => {
  it("takes a stand-in's port from the system but never one of REAL_PORTS, holding one that landed there until another is had", () => {
    const handedOut = [37317, 47317, 40000];
    const stopped: number[] = [];
    const server = offRealPorts(() => {
      const port = handedOut.shift()!;
      return { port, stop: () => { stopped.push(port); } };
    });
    expect({ port: server.port, stopped, left: handedOut }).toEqual({ port: 40000, stopped: [37317, 47317], left: [] });
  });

  it("names a quiet port, and never one this PC's own Ovis may be on", () => {
    const port = Number(launchEnv()["PORT"]);
    expect(Number.isInteger(port) && port > 0).toBe(true);
    expect(REAL_PORTS).not.toContain(port);
    for (const real of REAL_PORTS) expect(() => launchEnv({ PORT: String(real) })).toThrow(`PORT=${real}`);
    expect(() => launchEnv({ PORT: undefined })).toThrow("no port kept");
    expect(() => launchEnv({ PORT: "" })).toThrow("no port kept");
    writeFileSync(join(configDir, ".env"), "PORT=7421\n");
    expect(() => launchEnv()).toThrow("PORT=7421");
    writeFileSync(join(configDir, ".env"), "PORT=\n");
    expect(() => launchEnv({ PORT: "1" })).toThrow("no port kept");
    rmSync(join(configDir, ".env"));
    mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
    writeFileSync(join(scratch, ".config", "ovis", "plugin-port"), "7317\n");
    expect(() => launchEnv({ PORT: undefined })).toThrow("PORT=7317");
  });

  it("stops a command, and the Bun processes it starts, at a port this PC's own Ovis may be on", () => {
    const env = launchEnv();
    const script = `const child = Bun.spawnSync([process.execPath, "-e", "Bun.serve({ hostname: '127.0.0.1', port: 7317, fetch: () => new Response() })"]); process.exit(child.exitCode);`;
    const tried = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
    expect(tried.exitCode).not.toBe(0);
    expect(readFileSync(env["OVIS_TEST_REAL_PORTS_LOG"]!, "utf8")).toContain("serving on port 7317");
    rmSync(env["OVIS_TEST_REAL_PORTS_LOG"]!);
  });
});

describe("plugin settings files", () => {
  it("finds the config dir through herdr and reads .env", async () => {
    writeFileSync(join(configDir, ".env"), "PORT=1\n");
    const run = await status();
    expect(run.exitCode, run.err).toBe(0);
    expect(run.out).toContain("down http://127.0.0.1:1");
    expect(run.out).toContain(`config: ${join(configDir, ".env")}`);
  });

  it("still reads env, from older installs", async () => {
    writeFileSync(join(configDir, "env"), "PORT=2\n");
    const run = await status();
    expect(run.out).toContain("down http://127.0.0.1:2");
    expect(run.out).toContain(`config: ${join(configDir, "env")}`);
  });

  it("lets .env win over env and names the keys they disagree on, not their values", async () => {
    writeFileSync(join(configDir, "env"), "PORT=2\nOVIS_TOKEN=old-secret\nHOST=127.0.0.1\n");
    writeFileSync(join(configDir, ".env"), "PORT=1\nOVIS_TOKEN=new-secret\nHOST=127.0.0.1\n");
    const run = await status();
    expect(run.out).toContain("down http://127.0.0.1:1");
    expect(run.out).toContain(`config: ${join(configDir, "env")}, ${join(configDir, ".env")}`);
    expect(run.out).toContain("set PORT, OVIS_TOKEN; .env wins");
    expect(run.out).not.toContain("secret");
  });

  it("says where settings go when there are none", async () => {
    const run = await status();
    expect(run.out).toContain(`config: none (settings go in ${join(scratch, ".config", "ovis", "env")})`);
  });
});

/** Ovis for Windows reads this line to tell a server older than the app from one that updated itself. */
describe("the version status names", () => {
  function checkout(version: string): string {
    const root = join(scratch, "checkout");
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    Bun.spawnSync(["git", "init", "-q", root]);
    Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: root });
    return root;
  }

  it("is the checkout's while no update is installed", async () => {
    const root = checkout("0.4.1");
    const result = await run("status", { HERDR_PLUGIN_ROOT: root, OVIS_STATE_DIR: join(scratch, "app-state"), PORT: "1" });
    expect(result.exitCode, result.err).toBe(0);
    expect(result.out).toContain("version: 0.4.1\n");
  });

  it("is the release Settings \u2192 Updates installed, which herdr's plugin list does not name", async () => {
    const root = checkout("0.4.1");
    const state = join(scratch, "app-state");
    const updates = updateStateDir(root, 1, state);
    const release = join(updates, "release-test");
    mkdirSync(join(release, "scripts"), { recursive: true });
    writeFileSync(join(release, "scripts", "plugin.ts"), "");
    writeFileSync(join(release, "package.json"), JSON.stringify({ version: "0.4.9" }));
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
    writeFileSync(join(updates, "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
    const result = await run("status", { HERDR_PLUGIN_ROOT: root, OVIS_STATE_DIR: state, PORT: "1" });
    expect(result.exitCode, result.err).toBe(0);
    expect(result.out).toContain("version: 0.4.9\n");
  });
});

const BRIDGE_HEALTH = { ok: true, auth: { required: false, authenticated: true }, bridge_protocol: 1 };
const APP_HEALTH = { ok: true, herdr: { version: "0.9.3", protocol: 1 }, auth: { required: false, authenticated: true } };

describe("the herdr socket", () => {
  const socketSeen = async (): Promise<string> => {
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(scratch, "seen"))}, process.env.HERDR_SOCKET ?? "unset");\n`);
    await run("start", { HERDR_PLUGIN_ROOT: root, HERDR_SOCKET_PATH: "/herdr/own.sock", PORT: String(quietPort()) });
    return readFileSync(join(scratch, "seen"), "utf8");
  };

  it("passes herdr's socket on to the server", async () => {
    expect(await socketSeen()).toBe("/herdr/own.sock");
  });

  it("keeps a HERDR_SOCKET set in the plugin config over herdr's socket", async () => {
    writeFileSync(join(configDir, ".env"), "HERDR_SOCKET=/named/session.sock\n");
    expect(await socketSeen()).toBe("/named/session.sock");
  });
});

describe("server.log", () => {
  const failedStart = async (body: string) => {
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), `${body}\nprocess.exit(1);\n`);
    return run("start", { HERDR_PLUGIN_ROOT: root, PORT: String(quietPort()) });
  };
  const state = (name: string) => join(scratch, "state", name);

  it("keeps the run before as server.log.1 and starts a new server.log", async () => {
    mkdirSync(join(scratch, "state"));
    writeFileSync(state("server.log"), "older run\n");
    writeFileSync(state("server.log.1"), "oldest run\n");
    const started = await failedStart(`console.log("this run");`);
    expect(started.exitCode).toBe(1);
    expect(readFileSync(state("server.log.1"), "utf8")).toBe("older run\n");
    const log = readFileSync(state("server.log"), "utf8");
    expect(log).toStartWith("this run\n");
    expect(log).toContain("start: the server stopped (exit 1)");
  });

  it("appends while the recorded server is still alive", async () => {
    mkdirSync(join(scratch, "state"));
    writeFileSync(state("server.log"), "live run\n");
    writeFileSync(state("server.pid"), `${process.pid}\n`);
    await failedStart(`console.log("this run");`);
    expect(readFileSync(state("server.log"), "utf8")).toStartWith("live run\nthis run\n");
    expect(existsSync(state("server.log.1"))).toBe(false);
  });

  const shown = (err: string) => err.slice(err.indexOf("ends with:\n") + "ends with:\n".length).trimEnd().split("\n");

  it("reads only the log's end, without the line the read cut", async () => {
    const started = await failedStart(`process.stdout.write("x".repeat(100_000) + "\\nline 0\\nline 1\\n");`);
    expect(started.exitCode).toBe(1);
    expect(shown(started.err)).toEqual(["line 0", "line 1"]);
  });

  it("shows the end of a line too long to read whole", async () => {
    const started = await failedStart(`process.stdout.write("x".repeat(100_000) + "end\\n");`);
    expect(shown(started.err)).toEqual([`${"x".repeat(64 * 1024 - 4)}end`]);
  });

  it("shows the last 15 lines", async () => {
    const started = await failedStart(`console.log(Array.from({ length: 40 }, (_, i) => "line " + i).join("\\n"));`);
    expect(shown(started.err)).toEqual(Array.from({ length: 15 }, (_, i) => `line ${i + 25}`));
  });
});

describe("starts at the same moment", () => {
  it("open one server between them, whose record stop finds", async () => {
    const control = join(scratch, "control.sock");
    const servers: { pid: number; socket: { write(data: string): number } }[] = [];
    const listeners: (() => void)[] = [];
    let open = false;
    const listener = Bun.listen<undefined>({
      unix: control,
      socket: {
        data(socket, chunk) {
          servers.push({ pid: Number(String(chunk).trim()), socket });
          if (open) socket.write("go\n");
          for (const notify of listeners) notify();
        },
      },
    });
    const serversUp = (count: number) => new Promise<void>((resolve) => {
      const check = () => { if (servers.length >= count) resolve(); };
      listeners.push(check);
      check();
    });
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), `
      const go = Promise.withResolvers<void>();
      const socket = await Bun.connect({ unix: ${JSON.stringify(control)}, socket: { data() { go.resolve(); } } });
      socket.write(process.pid + "\\n");
      await go.promise;
      try {
        Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => Response.json(${JSON.stringify({ ...APP_HEALTH, bridge_protocol: 1 })}) });
      } catch {
        console.log("the port is taken");
        process.exit(1);
      }
    `);
    const port = String(quietPort());
    async function within<T>(promise: Promise<T>, what: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 15_000); })]);
      } finally { clearTimeout(timer); }
    }
    try {
      const first = launch("start", { HERDR_PLUGIN_ROOT: root, PORT: port });
      await within(serversUp(1), "the first start's server");
      const second = launch("start", { HERDR_PLUGIN_ROOT: root, PORT: port });
      const reader = second.stdout.getReader();
      const decoder = new TextDecoder();
      let secondOut = "";
      const readSecond = async (text?: string) => {
        while (text === undefined || !secondOut.includes(text)) {
          const { value, done } = await reader.read();
          if (done) return;
          secondOut += decoder.decode(value, { stream: true });
        }
      };
      const waits = readSecond("another start or stop of Ovis is running");
      await within(Promise.race([waits, serversUp(2)]), "the second start to wait or spawn");
      open = true;
      for (const server of servers) server.socket.write("go\n");
      const [firstOut, firstCode] = await within(Promise.all([new Response(first.stdout).text(), first.exited]), "the first start");
      const [secondCode] = await within(Promise.all([second.exited, waits.then(() => readSecond())]), "the second start");
      expect(servers.map((server) => server.pid), "regression (fails on main): the second start opened a second server").toHaveLength(1);
      const pid = servers[0]!.pid;
      expect(firstCode, firstOut).toBe(0);
      expect(secondCode, secondOut).toBe(0);
      expect(secondOut).toContain(`Ovis already running at http://127.0.0.1:${port}`);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${pid}\n`);
      const stopped = await run("stop", { HERDR_PLUGIN_ROOT: root, PORT: port });
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(stopped.out).toContain(`stopped Ovis (pid ${pid})`);
      // gone, or exited and not yet reaped by whatever adopted it: stop counts a zombie as gone, and
      // signal 0 still reaches one; without /proc (macOS) signal 0 is all there is
      if (existsSync("/proc/self/stat")) {
        const stat = (() => { try { return readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return null; } })();
        expect(stat === null ? "gone" : stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]).toMatch(/^(gone|Z)$/);
      } else expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      for (const { pid } of servers) try { process.kill(-pid, "SIGKILL"); } catch {}
      listener.stop(true);
    }
  }, 60_000);

  const recordedSleeper = (birth: (pid: number) => unknown) => {
    const server = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    mkdirSync(join(scratch, "state"), { recursive: true });
    writeFileSync(join(scratch, "state", "server.pid"), `${server.pid}\n`);
    writeFileSync(join(scratch, "state", "server.owner"), JSON.stringify({ pid: server.pid, birth: birth(server.pid!) }));
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(scratch, "spawned"))}, ""); process.exit(1);\n`);
    return { server, root };
  };
  const freePortNumber = async () => String(quietPort());

  it("leave a server an earlier start left running alone when it does not answer and its port is free", async () => {
    const { server, root } = recordedSleeper((pid) => { const reading = readProcessBirth(pid); return reading.state === "identified" ? reading.birth : null; });
    try {
      const started = await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      expect(existsSync(join(scratch, "spawned")), "regression (fails on main): a second server was spawned over the running one's record").toBe(false);
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`Ovis (pid ${server.pid}) is still running but does not answer`);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${server.pid}\n`);
    } finally { process.kill(-server.pid!, "SIGKILL"); }
  });

  it.skipIf(platform() === "win32" || process.getuid?.() === 0)("say at once that a state dir they cannot write stops them, instead of waiting on it as on another start", async () => {
    const dir = join(scratch, "state");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      const started = Date.now();
      const stopped = await run("stop");
      expect(stopped.exitCode).toBe(1);
      expect(stopped.err).toContain(`could not stop Ovis: ${join(dir, "lifecycle.lock.guard")} could not be opened`);
      expect(stopped.out, "regression: it waited as if another start held the lock").not.toContain("waiting for it to finish");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { chmodSync(dir, 0o700); }
  });

  it.skipIf(platform() !== "linux" || !Bun.which("setsid"))("start a server when the recorded one has exited but is not reaped yet", async () => {
    const parent = spawn("sh", ["-c", `setsid sh -c 'echo $$; exec sleep 0.2' & exec sleep 30`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const pid = Number(await new Promise<string>((resolve) => parent.stdout!.once("data", (chunk) => resolve(String(chunk).trim()))));
      const reading = readProcessBirth(pid);
      expect(reading.state).toBe("identified");
      const state = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      const deadline = Date.now() + 5_000;
      while (state() !== "Z" && Date.now() < deadline) await Bun.sleep(20);
      expect(state()).toBe("Z");
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
      writeFileSync(join(scratch, "state", "server.owner"), JSON.stringify({ pid, birth: reading.state === "identified" ? reading.birth : null }));
      const root = join(scratch, "root");
      mkdirSync(join(root, "server"), { recursive: true });
      writeFileSync(join(root, "server", "managed.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(scratch, "spawned"))}, ""); process.exit(1);\n`);
      const started = await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      expect(started.err, "regression: an exited, unreaped server was taken for a running one").not.toContain("is still running");
      expect(existsSync(join(scratch, "spawned"))).toBe(true);
    } finally { parent.kill("SIGKILL"); }
  }, 30_000);

  it("take turns in the dir herdr hands them, while the record is still under the old id's", async () => {
    const plugins = join(scratch, "plugins");
    const legacy = join(plugins, "devswha.herdr-web-ui");
    const current = join(plugins, "devswha.ovis");
    mkdirSync(legacy, { recursive: true });
    const server = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      recordStarted(legacy, server.pid!);
      const stopped = await run("stop", { HERDR_PLUGIN_STATE_DIR: current, PORT: "1" });
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(existsSync(join(current, "lifecycle.lock.guard"))).toBe(true);
      expect(existsSync(join(legacy, "lifecycle.lock.guard")), "regression: the lock followed the record into the old id's dir").toBe(false);
    } finally {
      try { process.kill(-server.pid!, "SIGKILL"); } catch {}
    }
  });

  it("keep a server whose birth matches though the clock stepped forward past the record", async () => {
    const { server, root } = recordedSleeper((pid) => { const reading = readProcessBirth(pid); return reading.state === "identified" ? reading.birth : null; });
    const beforeBoot = (Date.now() - uptime() * 1000) / 1000 - 3600;
    utimesSync(join(scratch, "state", "server.owner"), beforeBoot, beforeBoot);
    try {
      const started = await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      expect(existsSync(join(scratch, "spawned")), "regression: a live server with its own birth was taken for one from before this boot").toBe(false);
      expect(started.err).toContain(`Ovis (pid ${server.pid}) is still running but does not answer`);
      const stopped = await run("stop", { HERDR_PLUGIN_ROOT: root, PORT: "1" });
      expect(stopped.out).toContain(`stopped Ovis (pid ${server.pid})`);
      expect(() => process.kill(server.pid!, 0)).toThrow();
    } finally { try { process.kill(-server.pid!, "SIGKILL"); } catch {} }
  }, 30_000);

  it("leave a server alone whose birth could not be read when it was started, while it still runs", async () => {
    const { server, root } = recordedSleeper(() => undefined);
    writeFileSync(join(scratch, "state", "server.owner"), JSON.stringify({ pid: server.pid, birth_unknown: true }));
    try {
      const started = await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      expect(existsSync(join(scratch, "spawned")), "regression: a server whose birth could not be read was taken for gone").toBe(false);
      expect(started.err).toContain(`Ovis (pid ${server.pid}) is still running but does not answer`);
    } finally { process.kill(-server.pid!, "SIGKILL"); }
  });

  it("start a server when the PC restarted after a record whose birth could not be read", async () => {
    const { server, root } = recordedSleeper(() => undefined);
    const owner = join(scratch, "state", "server.owner");
    writeFileSync(owner, JSON.stringify({ pid: server.pid, birth_unknown: true }));
    const beforeBoot = (Date.now() - uptime() * 1000) / 1000 - 3600;
    utimesSync(owner, beforeBoot, beforeBoot);
    try {
      await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      expect(existsSync(join(scratch, "spawned"))).toBe(true);
    } finally { process.kill(-server.pid!, "SIGKILL"); }
  });

  const holdLock = async (guardOnly = false) => {
    const lock = join(scratch, "state", "lifecycle.lock");
    mkdirSync(join(scratch, "state"), { recursive: true });
    const module = JSON.stringify(join(ROOT, "server", "owner-guard.ts"));
    const say = `require("node:fs").writeSync(1, "HOLDING\\n")`;
    const script = guardOnly
      ? `const { withOwnerGuard } = await import(${module}); withOwnerGuard(${JSON.stringify(lock)}, () => { ${say}; require("node:fs").readSync(0, Buffer.alloc(1), 0, 1, null); });`
      : `const { acquireOwnerDirectory } = await import(${module}); const lease = acquireOwnerDirectory(${JSON.stringify(lock)}, { running: "x", starting: "x" }); ${say}; require("node:fs").readSync(0, Buffer.alloc(1), 0, 1, null); lease.release();`;
    const holder = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    await readUntil(holder.stdout.getReader(), "HOLDING", "the lock holder");
    return {
      release: async () => { holder.stdin.write("\n"); holder.stdin.end(); await holder.exited; },
      kill: () => holder.kill("SIGKILL"),
    };
  };
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, text: string, what: string) => {
    const decoder = new TextDecoder();
    let said = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not say "${text}" within 15s; it said: ${said}`)), 15_000); });
    try {
      while (!said.includes(text)) {
        const { value, done } = await Promise.race([reader.read(), late]);
        if (done) throw new Error(`${what} ended without saying "${text}"; it said: ${said}`);
        said += decoder.decode(value, { stream: true });
      }
      return said;
    } finally { clearTimeout(timer); }
  };

  it("do not block on the lock's guard while another process holds it, so they can say why they wait", async () => {
    const holder = await holdLock(true);
    try {
      const stop = launch("stop", { PORT: "1" });
      await readUntil(stop.stdout.getReader(), "waiting for it to finish", "regression: stop, blocked on the guard,");
      await holder.release();
      expect(await stop.exited).toBe(0);
    } finally { holder.kill(); }
  }, 30_000);

  it("follow the port a start they waited for moved to, and find its server there", async () => {
    const portA = await freePortNumber();
    const keepPort = (port: number | string) => {
      mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
      writeFileSync(join(scratch, ".config", "ovis", "plugin-port"), `${port}\n`);
    };
    keepPort(portA);
    const holder = await holdLock();
    const ours = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(APP_HEALTH) });
    const { server, root } = recordedSleeper((pid) => { const reading = readProcessBirth(pid); return reading.state === "identified" ? reading.birth : null; });
    rmSync(join(scratch, "state", "server.pid"));
    try {
      const start = launch("start", { HERDR_PLUGIN_ROOT: root, PORT: undefined });
      const reader = start.stdout.getReader();
      let out = await readUntil(reader, "waiting for it to finish", "the waiting start");
      keepPort(ours.port!);
      writeFileSync(join(scratch, "state", "server.pid"), `${server.pid}\n`);
      await holder.release();
      const code = await start.exited;
      for (;;) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
      expect(out, "regression: the start kept the port it read before its turn").toContain(`already running at http://127.0.0.1:${ours.port}`);
      expect(code).toBe(0);
      expect(existsSync(join(scratch, "spawned"))).toBe(false);
    } finally {
      holder.kill();
      process.kill(-server.pid!, "SIGKILL");
      await ours.stop(true);
    }
  }, 30_000);

  it("stop the server they spawned when its record cannot be written, so none runs unrecorded", async () => {
    mkdirSync(join(scratch, "state", "server.owner"), { recursive: true });
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), "setInterval(() => {}, 1 << 30);\n");
    let pid = 0;
    try {
      const started = await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      const recorded = existsSync(join(scratch, "state", "server.pid")) ? Number(readFileSync(join(scratch, "state", "server.pid"), "utf8").trim()) : 0;
      pid = Number(started.err.match(/could not record the server it started \(pid (\d+)\)/)?.[1] ?? recorded);
      expect(pid, started.err).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0), "regression: the unrecorded server kept running").toThrow();
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain("it was stopped");
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally { if (pid > 0) try { process.kill(-pid, "SIGKILL"); } catch {} }
  }, 30_000);

  it("start a server when the recorded pid now runs another process", async () => {
    const { server, root } = recordedSleeper(() => ({ platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : "Thu Jan 1 00:00:00 1970" }));
    try {
      const started = await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      expect(existsSync(join(scratch, "spawned"))).toBe(true);
      expect(started.err).toContain("the server stopped (exit 1)");
    } finally { process.kill(-server.pid!, "SIGKILL"); }
  });
});

describe("port", () => {
  const keep = (port: number) => {
    mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
    writeFileSync(join(scratch, ".config", "ovis", "plugin-port"), `${port}\n`);
  };

  it("reports the port an earlier start fell back to", async () => {
    keep(3);
    expect((await run("status", { PORT: undefined })).out).toContain("down http://127.0.0.1:3");
  });

  it("lets a PORT the user set win over the kept one", async () => {
    keep(3);
    writeFileSync(join(configDir, ".env"), "PORT=1\n");
    expect((await run("status", { PORT: undefined })).out).toContain("down http://127.0.0.1:1");
  });

  it("does not start on another port when the PORT the user set cannot be opened, and says so", async () => {
    const holder = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
    try {
      writeFileSync(join(configDir, ".env"), `PORT=${holder.port}\n`);
      const started = await run("start");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`port ${holder.port} on 127.0.0.1 cannot be opened`);
      expect(started.err).toContain(`Set another PORT in ${join(configDir, ".env")}`);
      expect(readFileSync(join(scratch, "state", "server.log"), "utf8")).toContain(`start: port ${holder.port} on 127.0.0.1 cannot be opened`);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
      expect(existsSync(join(scratch, ".config", "ovis", "plugin-port"))).toBe(false);
    } finally { await holder.stop(true); }
  });

  it("does not take another program's 200 on the port for the app", async () => {
    const stranger = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>not us</html>", { headers: { "content-type": "text/html" } }) });
    try {
      writeFileSync(join(configDir, ".env"), `PORT=${stranger.port}\n`);
      const started = await run("start");
      expect(started.out).not.toContain("already running");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`port ${stranger.port} on 127.0.0.1 cannot be opened`);
    } finally { await stranger.stop(true); }
  });

  it("does not take another program's JSON, or the app's shape with a failing status, for the app's bridge health", async () => {
    for (const bridge of [Response.json({ ok: true }), Response.json(BRIDGE_HEALTH, { status: 503 })]) {
      const stranger = serveOffRealPorts({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => new URL(request.url).searchParams.get("scope") === "bridge"
          ? bridge.clone()
          : Response.json({ error: { code: "unavailable", message: "not us" } }, { status: 503 }),
      });
      try {
        writeFileSync(join(configDir, ".env"), `PORT=${stranger.port}\n`);
        const started = await run("start");
        expect(started.err).not.toContain("Ovis is running");
        expect(started.exitCode).toBe(1);
        expect(started.err).toContain(`port ${stranger.port} on 127.0.0.1 cannot be opened`);
      } finally { await stranger.stop(true); }
    }
  });

  it("does not take another program answering ok on both health URLs for the app", async () => {
    const stranger = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      writeFileSync(join(configDir, ".env"), `PORT=${stranger.port}\n`);
      const started = await run("start");
      expect(started.out).not.toContain("already running");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`port ${stranger.port} on 127.0.0.1 cannot be opened`);
    } finally { await stranger.stop(true); }
  });

  it("follows a start that is coming up on another port instead of opening a second server", async () => {
    const ours = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(APP_HEALTH) });
    const stranger = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch: () => { keep(ours.port!); return new Response(null, { status: 404 }); } });
    try {
      keep(stranger.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`);
      const started = await run("start", { PORT: undefined });
      expect(started.out).toContain(`already running at http://127.0.0.1:${ours.port}`);
      expect(started.exitCode).toBe(0);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${process.pid}\n`);
      expect(readFileSync(join(scratch, ".config", "ovis", "plugin-port"), "utf8")).toBe(`${ours.port}\n`);
    } finally { await Promise.all([ours.stop(true), stranger.stop(true)]); }
  });

  it("keeps the port of its own server that cannot reach herdr instead of moving the app (#428)", async () => {
    const ours = serveOffRealPorts({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new URL(request.url).searchParams.get("scope") === "bridge"
        ? Response.json(BRIDGE_HEALTH)
        : Response.json({ error: { code: "connect_failed", message: "herdr socket unreachable" } }, { status: 502 }),
    });
    try {
      keep(ours.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`);
      // a start that moves anyway spawns no real server: there is no server/managed.ts under this root
      const started = await run("start", { HERDR_PLUGIN_ROOT: scratch, PORT: undefined });
      expect(started.out).not.toContain("instead");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`Ovis is running at http://127.0.0.1:${ours.port} (pid ${process.pid}) but cannot reach herdr: herdr socket unreachable`);
      expect(readFileSync(join(scratch, ".config", "ovis", "plugin-port"), "utf8")).toBe(`${ours.port}\n`);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${process.pid}\n`);
    } finally { await ours.stop(true); }
  }, 40_000);

  it("reports its own server as running when herdr comes back while start asks why it cannot reach it", async () => {
    let afterBridge = -1;
    const ours = serveOffRealPorts({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).searchParams.get("scope") === "bridge") { afterBridge = 0; return Response.json(BRIDGE_HEALTH); }
        if (afterBridge >= 0 && afterBridge++ >= 1) return Response.json(APP_HEALTH);
        return Response.json({ error: { code: "connect_failed", message: "herdr socket unreachable" } }, { status: 502 });
      },
    });
    try {
      keep(ours.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`);
      const started = await run("start", { HERDR_PLUGIN_ROOT: scratch, PORT: undefined });
      expect(started.err).not.toContain("cannot reach herdr");
      expect(started.exitCode).toBe(0);
      expect(started.out).toContain(`Ovis already running at http://127.0.0.1:${ours.port}`);
    } finally { await ours.stop(true); }
  }, 40_000);
});

describe("stop", () => {
  it("leaves the desktop app's server to the app: its ovis command neither starts nor stops one", async () => {
    const server = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${server.pid}\n`);
      const stopped = await run("stop", { OVIS_DESKTOP_COMMAND: "1", PORT: "1" });
      expect({ code: stopped.exitCode, out: stopped.out }).toEqual({ code: 1, out: "" });
      expect(stopped.err).toBe("The Ovis app stops its own server: quit the app from its menu or tray.\n");
      expect(() => process.kill(server.pid!, 0)).not.toThrow();
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${server.pid}\n`);
      rmSync(join(scratch, "state", "server.pid"));
      const started = await run("start", { OVIS_DESKTOP_COMMAND: "1", PORT: "1" });
      expect({ code: started.exitCode, err: started.err }).toEqual({ code: 1, err: "The Ovis app starts its own server: open the app.\n" });
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally {
      try { process.kill(-server.pid!, "SIGKILL"); } catch {}
    }
  });

  it("stops the server an install started under its old id after herdr updated the plugin to the new id", async () => {
    const plugins = join(scratch, "plugins");
    const legacy = join(plugins, "devswha.herdr-web-ui");
    mkdirSync(legacy, { recursive: true });
    const server = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      recordStarted(legacy, server.pid!);
      const stopped = await run("stop", { HERDR_PLUGIN_STATE_DIR: join(plugins, "devswha.ovis"), PORT: "1" });
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(existsSync(join(legacy, "server.pid"))).toBe(false);
      expect(() => process.kill(server.pid!, 0)).toThrow();
    } finally {
      try { process.kill(-server.pid!, "SIGKILL"); } catch {}
    }
  });

  it("signals nothing for a live process a bare pid file names, with no owner record to prove it is the server", async () => {
    const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${other.pid}\n`);
      const stopped = await run("stop", { PORT: "1" });
      expect(stopped.exitCode).toBe(1);
      expect(() => process.kill(other.pid!, 0), "regression: stop signalled a process it could not prove is the server").not.toThrow();
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${other.pid}\n`);
    } finally {
      try { process.kill(-other.pid!, "SIGKILL"); } catch {}
    }
  });

  it("does not signal a process that took the recorded server's pid", async () => {
    const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${other.pid}\n`);
      const earlier = { platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : "Thu Jan 1 00:00:00 1970" };
      writeFileSync(join(scratch, "state", "server.owner"), JSON.stringify({ pid: other.pid, birth: earlier }));
      const stopped = await run("stop", { PORT: "1" });
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(() => process.kill(other.pid!, 0), "regression: stop signalled a process that is not the server").not.toThrow();
      expect(stopped.out).toContain(`Ovis is not running (pid ${other.pid} now belongs to another process)`);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally {
      try { process.kill(-other.pid!, "SIGKILL"); } catch {}
    }
  });

  it("returns only once the server's process group is gone", async () => {
    const server = spawn("sh", ["-c", "trap 'sleep 1; exit 0' TERM; while :; do sleep 0.1; done"], { detached: true, stdio: "ignore" });
    const pid = server.pid!;
    recordStarted(join(scratch, "state"), pid);
    const started = Date.now();
    const stopped = await run("stop");
    expect(stopped.exitCode, stopped.err).toBe(0);
    expect(stopped.out).toContain(`stopped Ovis (pid ${pid})`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
  });

  it.skipIf(platform() !== "linux" || !Bun.which("setsid"))("counts an exited, unreaped server as gone", async () => {
    const parent = spawn("sh", ["-c", `setsid sh -c 'echo $$; exec sleep 0.2' & exec sleep 30`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const pid = Number(await new Promise<string>((resolve) => parent.stdout!.once("data", (chunk) => resolve(String(chunk).trim()))));
      const state = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      const deadline = Date.now() + 5_000;
      while (state() !== "Z" && Date.now() < deadline) await Bun.sleep(20);
      expect(state()).toBe("Z");
      // what `stop` waited on: the zombie's group still answers signal 0
      expect(() => process.kill(-pid, 0)).not.toThrow();
      recordStarted(join(scratch, "state"), pid);
      const started = Date.now();
      const stopped = await run("stop");
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(stopped.out).toContain(`stopped Ovis (pid ${pid})`);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally { parent.kill("SIGKILL"); }
  }, 30_000);
});

/** The pid and owner record a start writes for the server it spawned (the pid and its birth). */
function recordStarted(dir: string, pid: number): void {
  const reading = readProcessBirth(pid);
  if (reading.state !== "identified") throw new Error(`no birth for ${pid}: ${reading.state}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.pid"), `${pid}\n`);
  writeFileSync(join(dir, "server.owner"), JSON.stringify({ pid, birth: reading.birth }));
}

describe("the state dir when run by hand", () => {
  const legacy = () => join(scratch, ".local", "state", "herdr-web-ui");
  const managed = (base = join(scratch, ".local", "state")) => join(base, "herdr", "plugins", "devswha.ovis");
  const pidFile = (dir: string, pid: number) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "server.pid"), `${pid}\n`); };
  const byHand = (extra: Record<string, string | undefined> = {}) => run("status", { HERDR_PLUGIN_STATE_DIR: undefined, PORT: "1", ...extra });

  it("reads herdr's plugin state, under XDG_STATE_HOME when it is set", async () => {
    pidFile(managed(join(scratch, "state-home")), process.pid);
    expect((await byHand({ XDG_STATE_HOME: join(scratch, "state-home") })).out).toContain(`down http://127.0.0.1:1 (pid ${process.pid})`);
  });

  it("skips an old checkout's pid file whose server is gone", async () => {
    pidFile(legacy(), 999_999_999);
    pidFile(managed(), process.pid);
    expect((await byHand()).out).toContain(`(pid ${process.pid})`);
  });

  it("keeps a running checkout server's own dir", async () => {
    const other = Bun.spawn(["sleep", "30"]);
    try {
      pidFile(legacy(), other.pid);
      pidFile(managed(), process.pid);
      expect((await byHand()).out).toContain(`(pid ${other.pid})`);
    } finally { other.kill(); }
  });

  it("keeps the checkout's dir when herdr never installed the plugin", async () => {
    pidFile(legacy(), process.pid);
    expect((await byHand()).out).toContain(`(pid ${process.pid})`);
  });

  it("follows herdr's state dir on each platform", () => {
    expect(herdrStateDir({ XDG_STATE_HOME: "/x" }, "linux", "/h")).toBe(join("/x", "herdr"));
    expect(herdrStateDir({}, "darwin", "/h")).toBe(join("/h", ".local", "state", "herdr"));
    expect(herdrStateDir({ LOCALAPPDATA: "C:/L" }, "win32", "/h")).toBe(join("C:/L", "herdr"));
    expect(herdrStateDir({ USERPROFILE: "C:/U" }, "win32", "/h")).toBe(join("C:/U", "AppData", "Local", "herdr"));
  });
});

describe("ovis join, as the command runs it", () => {
  const env = () => ({ HOST: "127.0.0.1", PORT: "1", OVIS_STATE_DIR: join(scratch, "app-state") });

  it("reads the invite from a file or standard input, checks it before anything else, and answers --json with one object and its exit code", async () => {
    // a line for the account service the command uses by default
    const line = (await newInvite("https://account.ovis.sh", "acct_1", null)).line;
    const payload = line.slice("ovis-join:1:".length);
    const file = join(scratch, "invite");
    writeFileSync(file, `${line}\n`, { mode: 0o600 });
    for (const [args, stdin] of [[["--invite-file", file, "--json"], undefined], [["-", "--json"], ` ${line}\n`]] as const) {
      const result = await run("join", env(), { args: [...args], ...stdin === undefined ? {} : { stdin } });
      // the invite's form is good; nothing answers at this PC's port
      expect([args, result.exitCode]).toEqual([args, 13]);
      expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: "not_running" });
      expect(result.err).toContain("Ovis is not running on this PC.");
      for (const text of [result.out, result.err]) expect(text).not.toContain(payload.slice(-60));
    }
    writeFileSync(file, `ovis-invite:1:acct_1:${"Q".repeat(42)}w\n`);
    const wrong = await run("join", env(), { args: ["--invite-file", file] });
    expect(wrong.exitCode).toBe(3);
    expect(wrong.out).toContain("That is not an Ovis invite");
    // a line for another account service than this PC's
    writeFileSync(file, `${(await newInvite("https://account.test", "acct_1", null)).line}\n`);
    const elsewhere = await run("join", env(), { args: ["--invite-file", file, "--json"] });
    expect([elsewhere.exitCode, (JSON.parse(elsewhere.out) as { error: string }).error]).toEqual([3, "invite_invalid"]);
    const none = await run("join", env(), { args: [] });
    expect(none.exitCode).toBe(2);
    const fromEnv = await run("join", { ...env(), OVIS_INVITE: line }, { args: ["--json"] });
    expect(fromEnv.exitCode).toBe(13);
  });
});

for (const encoding of ["ASCII", "Unicode"]) {
  it.skipIf(process.platform === "win32")(`logout reads a healthy ${encoding} token-protected server without printing the token`, async () => {
    const { pairingPc } = await import("../server/account/pairing.test-helpers.ts");
    const token = encoding === "ASCII" ? "logout-fixture-token" : "logout-fixture-🔒";
    const herdrSocket = process.env["HERDR_SOCKET"];
    const unix = join(scratch, "herdr.sock");
    const herdr = Bun.listen<{ line: string }>({ unix, socket: {
      open(client) { client.data = { line: "" }; },
      data(client, chunk) {
        client.data.line += chunk.toString();
        if (!client.data.line.includes("\n")) return;
        const { id, method } = JSON.parse(client.data.line) as { id: string; method: string };
        const result = method === "ping" ? { version: "fixture", protocol: 22 } : { snapshot: { workspaces: [], panes: [] } };
        client.end(`${JSON.stringify({ id, result })}\n`);
      },
    } });
    process.env["HERDR_SOCKET"] = unix;
    try {
      const pc = await pairingPc({ startRelay: false, server: { token, accountOpensAll: true } });
      try {
        expect(await pc.local("/api/health")).toMatchObject({ status: 200, body: { ok: true, auth: { reason: "token_required" } } });
        expect((await pc.local("/api/account/status")).status).toBe(401);
        const result = await run("logout", {
          HOST: "127.0.0.1", PORT: String(pc.app.port), OVIS_STATE_DIR: pc.stateDir, OVIS_TOKEN: token,
          OVIS_PROFILE: undefined, OVIS_PREVIEW: undefined, OVIS_ACCOUNT_OPENS_ALL: "1", BUN_CONFIG_VERBOSE_FETCH: "curl",
        }, { timeout: 5_000 });
        expect(result.out).not.toContain(token);
        expect(result.err).not.toContain(token);
        expect(result.exitCode, result.out + result.err).toBe(0);
        expect(result.out).toContain("This PC is in no Ovis account.");
      } finally { await pc.close(); }
    } finally {
      herdr.stop(true);
      if (herdrSocket === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = herdrSocket;
    }
  });
}

describe("the devices status lists apart", () => {
  const GROUPS = { unlinked: [{ id: "6a1f0c9e2b7d4a10", label: "Old phone" }], own_word: [{ id: "0d4c1b7a9e2f3c58", label: "Tab\u001b]0;let\u0007let" }, { id: "1e5d2c8b0a3f4d69", label: "Laptop" }] };
  /** An Ovis on a port of its own whose health answer is `answer` for each request, by the request's authorization. */
  function answering(answer: (authorization: string | null) => Record<string, unknown>, account?: Record<string, unknown>) {
    const asked: (string | null)[] = [];
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (account !== undefined && new URL(request.url).pathname === "/api/account/status") return Response.json(account);
      if (new URL(request.url).pathname !== "/api/health") return new Response(null, { status: 404 });
      asked.push(request.headers.get("authorization"));
      return Response.json(answer(request.headers.get("authorization")));
    } });
    writeFileSync(join(configDir, ".env"), `PORT=${server.port}\n`);
    return { server, asked, env: { HOST: "127.0.0.1", HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: join(scratch, "app-state"), OVIS_TOKEN: "" } };
  }
  const lines = (out: string) => out.split("\n").filter((line) => /^(relay )?devices /.test(line));

  it("--json is one object an agent reads: version, running, server id, relay, account and whether it waits for Add, with no token or address in it", async () => {
    const serverId = "0123456789abcdef0123456789abcdef";
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") return Response.json({ ...APP_HEALTH, account_devices: { unlinked: [], own_word: [] }, relay: { phase: "connecting" } });
      if (path === "/api/account/status") return Response.json({ account: null, members: 0, waiting_for_add: true });
      if (path === "/api/relay") return Response.json({ phase: "connecting", blocked: null, server_id: serverId });
      return new Response(null, { status: 404 });
    } });
    writeFileSync(join(configDir, ".env"), `PORT=${server.port}\n`);
    try {
      const result = await run("status", { HOST: "127.0.0.1", HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: join(scratch, "app-state"), OVIS_TOKEN: "the-token" }, { args: ["--json"] });
      expect(result.exitCode, result.err).toBe(0);
      expect(result.out.split("\n")).toHaveLength(2);
      const said = JSON.parse(result.out) as Record<string, unknown>;
      expect({ ...said, version: typeof said["version"] }).toEqual({
        version: "string", running: true, server_id: serverId, relay: { on: true, connected: false, phase: "connecting" },
        account: null, account_known: true, waiting_for_add: true, list: null, problem: null,
      });
      expect(result.out).not.toContain("the-token");
    } finally { await server.stop(true); }
    // nothing answers: down, and nothing else is known
    const down = await run("status", { HOST: "127.0.0.1", PORT: "1", OVIS_STATE_DIR: join(scratch, "app-state") }, { args: ["--json"] });
    expect(down.exitCode).toBe(0);
    const said = JSON.parse(down.out) as Record<string, unknown>;
    expect({ ...said, version: typeof said["version"] }).toEqual({ version: "string", running: false, server_id: null, relay: null, account: null, account_known: false, waiting_for_add: null, list: null, problem: null });
  });

  it("--json says of a PC pinned to its account's list which list it is, where the PC stands in it and why it lets nobody in; and of a PC that cannot read its account state, what it cannot read", async () => {
    const reason = "This PC cannot read its copy of your account's list (account-list.json), so it lets no device of your account in.";
    let strict = false;
    const answers: { status: () => Response } = { status: () => Response.json({ account: "acct_1a2b3c4d5e6f", members: 1, waiting_for_add: false, list: { pinned_list: "ab".repeat(32), standing: null, reason } }) };
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      // a PC that is closed tells this command, as any caller, no owner's fields: only that it is closed
      if (path === "/api/health") return Response.json(strict ? { ...APP_HEALTH, auth: { required: true, authenticated: false, reason: "strict" }, relay: { phase: "online" } }
        : { ...APP_HEALTH, account_devices: { unlinked: [], own_word: [] }, relay: { phase: "online" } });
      if (path === "/api/account/status") return answers.status();
      return new Response(null, { status: 404 });
    } });
    writeFileSync(join(configDir, ".env"), `PORT=${server.port}\n`);
    const env = { HOST: "127.0.0.1", HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: join(scratch, "app-state"), OVIS_TOKEN: "" };
    try {
      const pinned = JSON.parse((await run("status", env, { args: ["--json"] })).out) as Record<string, unknown>;
      expect(pinned).toMatchObject({ account: "acct_1a2b3c4d5e6f", account_known: true, list: { pinned_list: "ab".repeat(32), standing: null, reason }, problem: null });
      expect("migrate_time_scale" in pinned).toBe(false);
      // a staging run that turned the waits of a move onto the list down says so
      answers.status = () => Response.json({ account: "acct_1a2b3c4d5e6f", members: 1, waiting_for_add: false, migrate_time_scale: 60 });
      expect(JSON.parse((await run("status", env, { args: ["--json"] })).out)).toMatchObject({ migrate_time_scale: 60 });
      // closed altogether: the PC says what it cannot read, and nothing else of its account
      const why = "This PC is pinned to a signed list in /home/me/.herdr, and /home/me/.herdr/account-list-keys.json could not be brought beside it (ENOENT)";
      strict = true;
      answers.status = () => Response.json({ error: { code: "strict", message: "This PC cannot read its safety log", reason: why } }, { status: 403 });
      const closed = JSON.parse((await run("status", env, { args: ["--json"] })).out) as Record<string, unknown>;
      expect(closed).toMatchObject({ account: null, account_known: false, list: null, problem: why });
    } finally { await server.stop(true); }
  });

  it("are the two groups of the owner's health answer, each device by its name with no control character, and its id", async () => {
    const pc = answering(() => ({ ...APP_HEALTH, account_devices: GROUPS }));
    try {
      const result = await run("status", pc.env);
      expect(result.exitCode, result.err).toBe(0);
      expect(lines(result.out)).toEqual([
        "relay devices outside the account: Old phone (6a1f0c9e2b7d4a10)",
        "devices that joined the account on their own word: Tab]0;letlet (0d4c1b7a9e2f3c58), Laptop (1e5d2c8b0a3f4d69)",
      ]);
      expect(pc.asked).toEqual([null]);
    } finally { await pc.server.stop(true); }
  });

  it("come under the account, named in the short form ovis login uses, never its whole id", async () => {
    const pc = answering(() => ({ ...APP_HEALTH, account_devices: { unlinked: [], own_word: [] } }), { account: "acct_0123456789abcdef", members: 2 });
    try {
      const result = await run("status", pc.env);
      expect(result.out.split("\n").filter((line) => line.startsWith("account: ")), result.err).toEqual(["account: acct_0123456 (2 devices)"]);
    } finally { await pc.server.stop(true); }
  });

  it("say none for an empty group, and are not printed by a server that sends none", async () => {
    const empty = answering(() => ({ ...APP_HEALTH, account_devices: { unlinked: [], own_word: [] } }));
    try {
      expect(lines((await run("status", empty.env)).out)).toEqual(["relay devices outside the account: none", "devices that joined the account on their own word: none"]);
    } finally { await empty.server.stop(true); }
    const older = answering(() => APP_HEALTH);
    try {
      // it let the command in: nothing is asked again, with the token or without
      const result = await run("status", { ...older.env, OVIS_TOKEN: "the-token" });
      expect(result.out.split("\n")[0]).toBe(`running http://127.0.0.1:${older.server.port}`);
      expect(lines(result.out)).toEqual([]);
      expect(older.asked).toEqual([null]);
    } finally { await older.server.stop(true); }
  });

  /**
   * `status` with fetch replaced inside the command, so nothing listens: each request gets the next of `answers` (the
   * last one again once they run out). What it printed, and each request's path and authorization.
   */
  async function statusAnswering(answers: readonly Record<string, unknown>[], token: string): Promise<{ out: string; asked: string }> {
    writeFileSync(join(configDir, ".env"), "PORT=9\n");
    const asked = join(scratch, "asked");
    rmSync(asked, { force: true });
    const plugin = JSON.stringify(join(ROOT, "scripts", "plugin.ts"));
    const child = Bun.spawn([process.execPath, "-e", `import { appendFileSync } from "node:fs";
const answers = ${JSON.stringify(answers)};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  appendFileSync(${JSON.stringify(asked)}, \`\${new URL(request.url).pathname} \${request.headers.get("authorization") ?? "none"}\\n\`);
  return Response.json(answers.length > 1 ? answers.shift() : answers[0]);
};
process.argv = [process.execPath, ${plugin}, "status"];
const { runPlugin } = await import(${plugin});
await runPlugin();`], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: launchEnv({ HOST: "127.0.0.1", HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: join(scratch, "app-state"), OVIS_TOKEN: token }) });
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode, err).toBe(0);
    expect(out.split("\n")[0]).toBe("running http://127.0.0.1:9");
    return { out, asked: readFileSync(asked, "utf8") };
  }
  const notice = (out: string) => out.split("\n").filter((line) => line.startsWith("account devices: "));

  it("are never asked for with the token over TCP: the app's answer that did not let the command in is the one request, and status says so", async () => {
    // its first answer is the app's and lets nothing in, and whatever answers the same address next would be handed the
    // token (an earlier status asked again with it)
    const { out, asked } = await statusAnswering([{ ...APP_HEALTH, auth: { required: true, authenticated: false, reason: "token_required" } }, { ...APP_HEALTH, account_devices: GROUPS }], "the-token");
    expect(asked).toBe("/api/health none\n");
    expect(lines(out)).toEqual([]);
    expect(notice(out)).toHaveLength(1);
    expect(notice(out)[0]).toContain("token");
    expect(out).not.toContain("the-token");
  });

  it("print a device's id with no control character, on its group's one line", async () => {
    const groups = { unlinked: [{ id: "6a1f0c9e\n2b7d4a10", label: "Old phone" }], own_word: [{ id: "0d4c1b7a\u001b[2J9e2f3c58", label: "Tab" }] };
    const { out } = await statusAnswering([{ ...APP_HEALTH, account_devices: groups }], "");
    expect(lines(out)).toEqual([
      "relay devices outside the account: Old phone (6a1f0c9e2b7d4a10)",
      "devices that joined the account on their own word: Tab (0d4c1b7a[2J9e2f3c58)",
    ]);
  });

  it("name the token as the reason they are not shown only when the app asks for it", async () => {
    // a PC that wants this device paired, with no token set, and an open LAN that lets the command in but is not its owner
    for (const auth of [{ required: true, authenticated: false, reason: "pairing_required" }, { required: false, authenticated: true, via: "open", role: "drive" }]) {
      const { out, asked } = await statusAnswering([{ ...APP_HEALTH, auth }], "");
      expect(asked).toBe("/api/health none\n");
      expect(lines(out)).toEqual([]);
      expect(notice(out)).toHaveLength(1);
      expect(notice(out)[0]).not.toContain("token");
    }
  });
});

describe("add and login", () => {
  function linkedPc() {
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") return Response.json(APP_HEALTH);
      if (path === "/api/account/status") return Response.json({ account: "acct_1", unlinked: [], removals: [], adds: [], blocked: [] });
      return new Response(null, { status: 404 });
    } });
    writeFileSync(join(configDir, ".env"), `PORT=${server.port}\n`);
    return { server, env: { HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: join(scratch, "app-state"), OVIS_TOKEN: "" } };
  }

  it("are names of link", async () => {
    expect(COMMAND_ALIASES).toEqual({ add: "link", login: "link" });
    const { server, env } = linkedPc();
    try {
      for (const name of ["link", "add", "login"]) {
        const result = await run(name, env);
        expect([name, result.out, result.exitCode], result.err).toEqual([name, "This PC is already in an Ovis account (acct_1).\n", 0]);
      }
    } finally { server.stop(true); }
  });

  it("run the release the app updated to as link, the one name a release from before them knows", async () => {
    const { server, env } = linkedPc();
    try {
      const release = join(updateStateDir(ROOT, server.port!, join(scratch, "app-state")), "release-test");
      mkdirSync(join(release, "scripts"), { recursive: true });
      writeFileSync(join(release, "scripts", "plugin.ts"), 'console.log("active release", process.argv.slice(2).join(" "));');
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true }).stdout.toString().trim();
      writeFileSync(join(release, "..", "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
      for (const name of ["add", "login"]) {
        const result = await run(name, env);
        expect([result.out, result.exitCode], result.err).toEqual(["active release link\n", 0]);
      }
    } finally { server.stop(true); }
  });

  it("hand a command this checkout does not know to the release the app updated to, as it is", async () => {
    const { server, env } = linkedPc();
    try {
      const release = join(updateStateDir(ROOT, server.port!, join(scratch, "app-state")), "release-test");
      mkdirSync(join(release, "scripts"), { recursive: true });
      writeFileSync(join(release, "scripts", "plugin.ts"), 'console.log("active release", process.argv.slice(2).join(" ")); process.exit(3);');
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true }).stdout.toString().trim();
      writeFileSync(join(release, "..", "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
      const result = await run("a-later-command", env);
      expect([result.out, result.exitCode], result.err).toEqual(["active release a-later-command\n", 3]);
    } finally { server.stop(true); }
  });

  it("take the code back when the output went away: a write that fails stops the run as its signal would", async () => {
    const key = generateKeyPair();
    const calls: string[] = [];
    let codes = 0;
    let cancelled: (() => void) | null = null;
    const taken = new Promise<void>((resolve) => { cancelled = resolve; });
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") return Response.json(APP_HEALTH);
      calls.push(`${request.method} ${path}`);
      if (path === "/api/relay") return Response.json({ phase: "online", blocked: null });
      const soon = new Date(Date.now() + 1_000).toISOString();
      if (path === "/api/relay/code") return Response.json({ code: `ABCD-EFGH-J${++codes}`, expires_at: soon, server_id: "0123456789abcdef0123456789abcdef" });
      if (path === "/api/relay/offer") return Response.json({ url: encodeOffer({ v: 1, server_id: "0123456789abcdef0123456789abcdef", server_public_key: exportPublicKey(key.publicKey), relay: "wss://relay.ovis.sh", code: "123456" }, "https://app.ovis.sh"), expires_at: soon });
      if (path === "/api/devices/pair/cancel") { cancelled?.(); return Response.json({ ok: true, cancelled: true }); }
      return new Response(null, { status: 404 });
    } });
    writeFileSync(join(configDir, ".env"), `PORT=${server.port}\n`);
    const child = Bun.spawn(["sh", "-c", "bun scripts/plugin.ts link --code | head -n 2"], {
      cwd: ROOT, stdout: "pipe", stderr: "pipe",
      env: launchEnv({ HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: join(scratch, "app-state"), OVIS_TOKEN: "" }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: "taken back" | "left valid";
    try {
      result = await Promise.race([
        taken.then(() => "taken back" as const),
        child.exited.then(() => "left valid" as const),
        new Promise<"left valid">((resolve) => { timer = setTimeout(() => resolve("left valid"), 15_000); }),
      ]);
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
      await server.stop(true);
    }
    expect([result, calls.filter((call) => call === "POST /api/relay/offer").length], await new Response(child.stderr).text()).toEqual(["taken back", 2]);
  }, 30_000);

  it("are in the help, and an unknown command names itself and the help on stderr", async () => {
    const result = await run("constructor", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "1" });
    expect([result.exitCode, result.out, result.err]).toEqual([2, "", "ovis: unknown command constructor\nRun ovis --help for the commands.\n"]);
    const help = await run("--help", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "1" });
    expect([help.exitCode, help.err]).toEqual([0, ""]);
    for (const line of ["  login      Add this PC to your Ovis account (also: add)", "  logout     ", "  recover    ", "  confirm    "]) expect(help.out).toContain(line);
  });

  it("--help and an unknown flag come before a command runs: stop --help stops nothing", async () => {
    const env = { HERDR_PLUGIN_CONFIG_DIR: configDir };
    const help = await run("stop", env, { args: ["--help"] });
    expect([help.exitCode, help.out]).toEqual([0, "Usage: ovis stop\n\nStop Ovis on this PC\n"]);
    const typo = await run("login", env, { args: ["--aprove"] });
    expect([typo.exitCode, typo.out, typo.err]).toEqual([2, "", "ovis login: unknown flag --aprove\nRun ovis login --help for what it takes.\n"]);
  });

  it("--version is the version on stdout", async () => {
    const result = await run("--version", { HERDR_PLUGIN_CONFIG_DIR: configDir });
    expect([result.exitCode, result.out]).toEqual([0, `${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}\n`]);
  });

  it("plain ovis in a script is status, as before", async () => {
    const child = Bun.spawn(["bun", "scripts/plugin.ts"], { cwd: ROOT, env: launchEnv({ HERDR_PLUGIN_CONFIG_DIR: configDir, PORT: String(quietPort()) }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect([code, out.split(" ")[0]]).toEqual([0, "down"]);
  });

  it("with the release flag off, recover is not a command and the usage does not offer it (T70, flag off)", async () => {
    const result = await run("recover", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "0" });
    expect([result.exitCode, result.err]).toEqual([2, "ovis: unknown command recover\nRun ovis --help for the commands.\n"]);
    expect((await run("--help", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "0" })).out).not.toContain("recover");
  });

  it.each([undefined, "1", "", "false"])("with Step 2 flag %j, confirm prints this PC's confirm page without a desktop", async (flag) => {
    const state = join(scratch, "app-state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(join(state, "local-confirm.json"), JSON.stringify({ port: 41234 }), { mode: 0o600 });
    const result = await run("confirm", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: flag, OVIS_STATE_DIR: state, DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
    expect({ code: result.exitCode, out: result.out }).toEqual({ code: process.platform === "linux" ? 0 : 1, out: expect.stringContaining(process.platform === "linux" ? "http://127.0.0.1:41234/" : "Linux") });
  });

  it("with the release flag on under Wayland, confirm opens the page it built with xdg-open", async () => {
    const state = join(scratch, "app-state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(join(state, "local-confirm.json"), JSON.stringify({ port: 41234 }), { mode: 0o600 });
    const opened = join(scratch, "opened");
    writeFileSync(join(scratch, "bin", "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${opened}"\n`);
    chmodSync(join(scratch, "bin", "xdg-open"), 0o755);
    const result = await run("confirm", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "1", OVIS_STATE_DIR: state, DISPLAY: undefined, WAYLAND_DISPLAY: "wayland-0" });
    if (process.platform !== "linux") { expect(result.exitCode).toBe(1); return; }
    expect(result.exitCode).toBe(0);
    // the opener is started detached: wait for what it writes, not for a time
    const written = (): boolean => existsSync(opened) && readFileSync(opened, "utf8").endsWith("\n");
    await new Promise<void>((resolve) => {
      const watcher = watch(scratch, () => { if (written()) { watcher.close(); resolve(); } });
      if (written()) { watcher.close(); resolve(); }
    });
    expect(readFileSync(opened, "utf8")).toBe("http://127.0.0.1:41234/\n");
  });

  it("with the release flag off, confirm is not a command and the usage does not offer it (flag off)", async () => {
    const result = await run("confirm", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "0" });
    expect([result.exitCode, result.err]).toEqual([2, "ovis: unknown command confirm\nRun ovis --help for the commands.\n"]);
    expect((await run("--help", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "0" })).out).not.toContain("confirm");
  });

  it("T70: recover uses the release flag from the same config as the server", async () => {
    writeFileSync(join(configDir, ".env"), "OVIS_ACCOUNT_OPENS_ALL=1\n");
    const result = await run("recover", { HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_ACCOUNT_OPENS_ALL: "0" });
    expect(result.exitCode).toBe(1);
    expect(result.out).toMatch(/recovery socket|desktop app/);
  });
});

describe.skipIf(platform() === "win32")("a machine profile, under the fleet preview", () => {
  type Call = { door: "socket" | "tcp"; call: string; host: string | null; origin: string | null };
  const walked = (): string => {
    const parent = platform() === "win32" || trustRefusal(realpathSync(tmpdir()), profileGroups(), true) === null ? tmpdir() : "/tmp";
    const home = mkdtempSync(join(parent, "ovis-plugin-profile-"));
    homes.push(home);
    return home;
  };
  const homes: string[] = [];
  afterEach(() => { for (const home of homes.splice(0)) { chmodSync(home, 0o700); rmSync(home, { recursive: true, force: true }); } });
  /** OVIS_TOKEN of every run here: the profile ignores it, and no output names it */
  const TOKEN = "plugin-profile-test-token";
  function profilePc(record: Record<string, unknown> | string = { door: 1 }, more: { owner?: (path: string) => Response | undefined; at?: string; named?: string; tcp?: true | Record<string, unknown>; linked?: true; folderMode?: number; parentMode?: number } = {}) {
    const calls: Call[] = [];
    const bearers: string[] = [];
    const home = walked();
    const state = join(home, "state");
    mkdirSync(join(state, "serve.lock"), { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    const own = join(realpathSync(state), "serve.sock");
    const socket = more.at ?? (more.linked ? join(home, "elsewhere.sock") : own);
    mkdirSync(dirname(socket), { recursive: true });
    rmSync(socket, { force: true });
    const seen = (door: Call["door"], request: Request): string => {
      const path = new URL(request.url).pathname;
      calls.push({ door, call: `${request.method} ${path}`, host: request.headers.get("host"), origin: request.headers.get("origin") });
      bearers.push(`${door} ${request.method} ${path} ${request.headers.has("authorization") ? "with" : "without"} authorization`);
      return path;
    };
    const owner = Bun.serve({ unix: socket, fetch(request) {
      const path = seen("socket", request);
      const instead = more.owner?.(path);
      if (instead !== undefined) return instead;
      if (path === "/api/health") return Response.json({ ...APP_HEALTH, auth: { required: false, authenticated: true, via: "local", role: "drive" }, machine_profile: { engine: "herdr", runtime_down: false, reason: null } });
      if (path === "/api/account/status") return Response.json({ account: "acct_1", unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay/pairings") return Response.json({ pairings: [] });
      return new Response(null, { status: 404 });
    } });
    chmodSync(socket, 0o600);
    if (more.linked) symlinkSync(socket, own);
    const tcp = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (seen("tcp", request) === "/api/health") return Response.json(more.tcp === undefined ? { ok: true } : more.tcp === true ? APP_HEALTH : more.tcp);
      return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
    } });
    writeFileSync(join(state, "serve.lock", "http.json"), typeof record === "string" ? record : JSON.stringify({ port: tcp.port, hostname: "127.0.0.1", socket: more.named ?? (more.linked ? own : socket), ...record }));
    if (more.folderMode !== undefined) chmodSync(state, more.folderMode);
    if (more.parentMode !== undefined) chmodSync(home, more.parentMode);
    const settings = (lines = ""): void => writeFileSync(join(configDir, ".env"), `PORT=${tcp.port}\n${lines}`);
    settings();
    const env: Record<string, string | undefined> = { HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: state, OVIS_TOKEN: TOKEN, OVIS_PROFILE: "machine", OVIS_PREVIEW: "fleet" };
    return { calls, bearers, port: tcp.port!, socket, state, home, env, settings, stop: async () => { await owner.stop(true); await tcp.stop(true); } };
  }
  /** What a run printed, which names neither the token nor the socket's path */
  const printed = (pc: { socket: string }, ...runs: { out: string; err: string }[]): string => {
    const text = runs.map((one) => one.out + one.err).join("");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(pc.socket);
    return text;
  };

  it("is read on its owner socket as http://localhost: status says it runs, add reads its account there, pair --approve its waiting devices", async () => {
    const pc = profilePc();
    try {
      const status = await run("status", pc.env);
      expect(status.out.split("\n")[0], status.err).toBe(`running http://127.0.0.1:${pc.port}`);
      const add = await run("add", pc.env);
      expect([add.out, add.exitCode], add.err).toEqual(["This PC is already in an Ovis account (acct_1).\n", 0]);
      const approve = await run("pair", pc.env, { args: ["--approve"] });
      expect([approve.out, approve.exitCode], approve.err).toEqual(["No device is waiting to pair.\n", 0]);
      printed(pc, status, add, approve);
    } finally { await pc.stop(); }
    expect(pc.calls).toEqual([
      { door: "socket", call: "GET /api/health", host: "localhost", origin: null },
      { door: "socket", call: "GET /api/health", host: "localhost", origin: null },
      { door: "socket", call: "GET /api/account/status", host: "localhost", origin: null },
      { door: "socket", call: "GET /api/health", host: "localhost", origin: null },
      { door: "socket", call: "GET /api/relay/pairings", host: "localhost", origin: "http://localhost" },
      { door: "socket", call: "GET /api/relay/joins", host: "localhost", origin: "http://localhost" },
    ]);
  }, 30_000);

  it("takes OVIS_PREVIEW and OVIS_PROFILE from the plugin's settings file as from its environment, the file after the environment", async () => {
    const ways: [string, Record<string, string | undefined>, string, "socket" | "tcp"][] = [
      ["both in the file only", { OVIS_PREVIEW: undefined, OVIS_PROFILE: undefined }, "OVIS_PREVIEW=fleet\nOVIS_PROFILE=machine\n", "socket"],
      ["the preview in the file over another value in the environment", { OVIS_PREVIEW: "other" }, "OVIS_PREVIEW=fleet\n", "socket"],
      ["the preview turned off in the file over fleet in the environment", {}, "OVIS_PREVIEW=\n", "tcp"],
      ["another profile in the file over machine in the environment", {}, "OVIS_PROFILE=other\n", "tcp"],
    ];
    for (const [label, change, lines, door] of ways) {
      const pc = profilePc();
      try {
        pc.settings(lines);
        const status = await run("status", { ...pc.env, ...change });
        expect([label, status.out.split("\n")[0]]).toEqual([label, `${door === "socket" ? "running" : "down"} http://127.0.0.1:${pc.port}`]);
        printed(pc, status);
      } finally { await pc.stop(); }
      expect([label, pc.calls.map((call) => call.door)]).toEqual([label, [door]]);
    }
  }, 60_000);

  it("is asked on its TCP port when the preview is off or OVIS_PROFILE is not machine; with both, a record that is missing, unreadable, names no door or another socket than its own leaves it not running and asks nothing", async () => {
    const elsewhere = join(scratch, "elsewhere", "serve.sock");
    const linked = join(scratch, "linked-state");
    const ways: [string, Record<string, string | undefined>, Record<string, unknown> | string | null, { at?: string; named?: string }?][] = [
      ["a live socket outside the state folder", {}, { door: 1 }, { at: elsewhere }],
      ["a relative path to a live socket", {}, { door: 1 }, { at: elsewhere, named: relative(ROOT, elsewhere) }],
      ["its own socket named through a link to the state folder", {}, { door: 1 }, { named: join(linked, "serve.sock") }],
      ["no preview", { OVIS_PREVIEW: undefined }, { door: 1 }],
      ["a preview list without fleet", { OVIS_PREVIEW: "fleets" }, { door: 1 }],
      ["no profile", { OVIS_PROFILE: undefined }, { door: 1 }],
      ["another profile", { OVIS_PROFILE: "machines" }, { door: 1 }],
      ["no door in its record", {}, {}],
      ["another door", {}, { door: 2 }],
      ["a door with no socket", {}, { door: 1, socket: 7 }],
      ["a record that is not JSON", {}, "{door: 1"],
      ["no record", {}, null],
    ];
    for (const [label, change, record, where] of ways) {
      const pc = profilePc(record ?? "", where);
      if (record === null) rmSync(join(pc.state, "serve.lock", "http.json"));
      rmSync(linked, { force: true });
      symlinkSync(pc.state, linked);
      try {
        const env = { ...pc.env, ...change };
        const status = await run("status", env);
        const add = await run("add", env);
        expect([label, status.out.split("\n")[0], add.err, add.exitCode]).toEqual([label, `down http://127.0.0.1:${pc.port}`, `Ovis is not running at http://127.0.0.1:${pc.port}; start it first\n`, 1]);
        printed(pc, status, add);
      } finally { await pc.stop(); }
      // with both switches the health check goes to the owner socket only: none here, so nothing is asked
      const both = !("OVIS_PREVIEW" in change) && !("OVIS_PROFILE" in change);
      expect([label, pc.calls]).toEqual([label, !both ? [
        { door: "tcp", call: "GET /api/health", host: `127.0.0.1:${pc.port}`, origin: null },
        { door: "tcp", call: "GET /api/health", host: `127.0.0.1:${pc.port}`, origin: null },
      ] : []]);
    }
  }, 90_000);

  it("takes the health check on the owner socket only: an app answering full health on the TCP port is not taken, and gets no request", async () => {
    const pc = profilePc({ door: 1 }, { folderMode: 0o777, tcp: true });
    try {
      const status = await run("status", pc.env);
      const add = await run("add", pc.env);
      expect([status.out.split("\n")[0], add.err, add.exitCode]).toEqual([`down http://127.0.0.1:${pc.port}`, `Ovis is not running at http://127.0.0.1:${pc.port}; start it first\n`, 1]);
      printed(pc, status, add);
    } finally { await pc.stop(); }
    expect(pc.calls).toEqual([]);
  }, 30_000);

  it("does not take an app on the PORT it was given for the profile when starting, and starts nothing", async () => {
    const pc = profilePc({ door: 1 }, { folderMode: 0o777 });
    const asked: string[] = [];
    const app = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
      asked.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
      return Response.json(new URL(request.url).searchParams.get("scope") === "bridge" ? BRIDGE_HEALTH : APP_HEALTH);
    } });
    try {
      pc.settings();
      writeFileSync(join(configDir, ".env"), `PORT=${app.port}\n`);
      const started = await run("start", pc.env);
      expect([started.exitCode, started.out.includes("already running"), started.err.includes("ovis-server serve")], started.out + started.err).toEqual([1, false, true]);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally { await app.stop(true); await pc.stop(); }
    expect([asked, pc.calls]).toEqual([[], []]);
  }, 30_000);

  it.each([
    ["serve.sock is a link to a socket elsewhere, in a 0700 folder", { linked: true }],
    ["serve.sock is a link to a socket elsewhere, in a 0777 folder", { linked: true, folderMode: 0o777 }],
    ["the record and the socket are in a 0777 folder", { folderMode: 0o777 }],
    ["the record and the socket are in a 0700 folder inside a 0777 folder", { parentMode: 0o777 }],
  ] as const)("takes no owner socket when %s: the state folder must pass the profile's own check and serve.sock be a socket this account owns, else it is not running", async (_label, how) => {
    const pc = profilePc({ door: 1 }, how);
    try {
      const status = await run("status", pc.env);
      const add = await run("add", pc.env);
      expect([status.out.split("\n")[0], add.err, add.exitCode]).toEqual([`down http://127.0.0.1:${pc.port}`, `Ovis is not running at http://127.0.0.1:${pc.port}; start it first\n`, 1]);
      printed(pc, status, add);
    } finally { await pc.stop(); }
    expect(pc.calls).toEqual([]);
  }, 30_000);

  it("takes its own socket in a state folder that passes the profile's own check", async () => {
    const pc = profilePc();
    try {
      expect((await run("status", pc.env)).out.split("\n")[0]).toBe(`running http://127.0.0.1:${pc.port}`);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["socket GET /api/health"]);
  }, 30_000);

  it("does not wait for a writer when the record is a FIFO: status says down at once", async () => {
    const pc = profilePc();
    try {
      const record = join(pc.state, "serve.lock", "http.json");
      rmSync(record);
      expect(Bun.spawnSync(["mkfifo", "-m", "600", record]).exitCode).toBe(0);
      const status = await run("status", pc.env, { timeout: 20_000 });
      expect([status.out.split("\n")[0], status.exitCode], status.err).toEqual([`down http://127.0.0.1:${pc.port}`, 0]);
    } finally { await pc.stop(); }
    expect(pc.calls).toEqual([]);
  }, 30_000);

  it("takes no record larger than 4 KiB", async () => {
    const pc = profilePc();
    try {
      const own = JSON.stringify({ port: pc.port, hostname: "127.0.0.1", socket: join(realpathSync(pc.state), "serve.sock"), door: 1 });
      writeFileSync(join(pc.state, "serve.lock", "http.json"), `${own}${" ".repeat(4096)}`);
      expect((await run("status", pc.env)).out.split("\n")[0]).toBe(`down http://127.0.0.1:${pc.port}`);
      writeFileSync(join(pc.state, "serve.lock", "http.json"), own);
      expect((await run("status", pc.env)).out.split("\n")[0]).toBe(`running http://127.0.0.1:${pc.port}`);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["socket GET /api/health"]);
  }, 30_000);

  it("keeps the door a command's health check passed on: with the record gone after that, the later requests of pair --approve and add still go to the socket", async () => {
    let record = "";
    const pc: ReturnType<typeof profilePc> = profilePc({ door: 1 }, { owner: (path) => {
      if (path === "/api/health") rmSync(join(pc.state, "serve.lock", "http.json"), { force: true });
      if (path === "/api/devices/pair/start") return Response.json({ code: "123456", expires_at: new Date(Date.now() + 600_000).toISOString() });
      return undefined;
    } });
    record = readFileSync(join(pc.state, "serve.lock", "http.json"), "utf8");
    try {
      for (const [command, args] of [["pair", ["--approve"]], ["add", []]] as const) {
        writeFileSync(join(pc.state, "serve.lock", "http.json"), record);
        printed(pc, await run(command, pc.env, { args: [...args] }));
      }
    } finally { await pc.stop(); }
    expect(pc.calls.filter((call) => call.door === "tcp")).toEqual([]);
    expect(pc.calls.map((call) => call.call)).toEqual([
      "GET /api/health", "GET /api/relay/pairings", "GET /api/relay/joins",
      "GET /api/health", "GET /api/account/status",
    ]);
  }, 60_000);

  it("sends no token on its owner socket, while the same commands send it over TCP", async () => {
    const pc = profilePc({ door: 1 }, { tcp: true });
    try {
      for (const [command, args] of [["status", []], ["add", []], ["pair", ["--approve"]]] as const) printed(pc, await run(command, pc.env, { args: [...args] }));
      expect(pc.bearers.filter((call) => call.startsWith("tcp"))).toEqual([]);
      expect(pc.bearers.filter((call) => call.includes(" with "))).toEqual([]);
      expect(pc.bearers).toContain("socket GET /api/account/status without authorization");
      expect(pc.bearers).toContain("socket GET /api/relay/pairings without authorization");
      // control: no profile, so TCP, where the token goes as before
      pc.bearers.length = 0;
      for (const command of ["add", "pair"]) printed(pc, await run(command, { ...pc.env, OVIS_PROFILE: undefined }));
      expect(pc.bearers).toEqual([
        "tcp GET /api/health without authorization", "tcp GET /api/account/status with authorization",
        "tcp GET /api/health without authorization", "tcp POST /api/devices/pair/start with authorization",
      ]);
    } finally { await pc.stop(); }
  }, 30_000);

  it("finds its own socket when OVIS_STATE_DIR names the state folder through a link", async () => {
    const pc = profilePc();
    const linked = join(scratch, "linked-state");
    symlinkSync(pc.state, linked);
    try {
      const status = await run("status", { ...pc.env, OVIS_STATE_DIR: linked });
      expect(status.out.split("\n")[0], status.err).toBe(`running http://127.0.0.1:${pc.port}`);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["socket GET /api/health"]);
  }, 30_000);

  it("names the settings file when its OVIS_STATE_DIR hides the profile named on the command line, and only then", async () => {
    const pc = profilePc();
    const other = join(pc.home, "other-state");
    try {
      pc.settings(`OVIS_STATE_DIR=${other}\n`);
      const status = await run("status", pc.env);
      const add = await run("add", pc.env);
      const approve = await run("pair", pc.env, { args: ["--approve"] });
      const wayOut = `${join(configDir, ".env")} sets OVIS_STATE_DIR to ${other}, which wins over ${pc.state}. Run it with that profile's HERDR_PLUGIN_CONFIG_DIR, or set the same OVIS_STATE_DIR in the file.\n`;
      const stopped = `Ovis is not running at http://127.0.0.1:${pc.port}; start it first\n${wayOut}`;
      // status's stdout keeps its one line, which install.sh reads
      expect([status.out.split("\n")[0], status.err, add.err, add.exitCode, approve.err, approve.exitCode]).toEqual([`down http://127.0.0.1:${pc.port}`, wayOut, stopped, 1, stopped, 1]);
      printed(pc, status, add, approve);
      pc.settings(`OVIS_STATE_DIR=${pc.state}\n`);
      const same = await run("status", pc.env);
      expect(same.out.split("\n")[0], same.err).toBe(`running http://127.0.0.1:${pc.port}`);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["socket GET /api/health"]);
  }, 30_000);

  const ENGINE_DOWN = { ok: true, auth: { required: false, authenticated: true, via: "local", role: "drive" }, machine_profile: { engine: "herdr", runtime_down: true, reason: "herdr is not running for the selected session" } };

  it("takes a profile whose engine does not answer as running on its owner socket: status says the engine is down, add goes on", async () => {
    const pc = profilePc({ door: 1 }, { owner: (path) => path === "/api/health" ? Response.json(ENGINE_DOWN) : undefined });
    try {
      const status = await run("status", pc.env);
      expect(status.out.split("\n").slice(0, 2), status.err).toEqual([`running http://127.0.0.1:${pc.port}`, "engine: down (herdr is not running for the selected session)"]);
      const add = await run("add", pc.env);
      expect([add.out, add.exitCode], add.err).toEqual(["This PC is already in an Ovis account (acct_1).\n", 0]);
      printed(pc, status, add);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["socket GET /api/health", "socket GET /api/health", "socket GET /api/account/status"]);
  }, 30_000);

  it("does not take that health answer from a TCP port as the app's, with the preview off", async () => {
    const pc = profilePc({ door: 1 }, { tcp: ENGINE_DOWN });
    try {
      const env = { ...pc.env, OVIS_PREVIEW: undefined };
      const status = await run("status", env);
      const add = await run("add", env);
      expect([status.out.split("\n")[0], status.out.includes("engine:"), add.err, add.exitCode]).toEqual([`down http://127.0.0.1:${pc.port}`, false, `Ovis is not running at http://127.0.0.1:${pc.port}; start it first\n`, 1]);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["tcp GET /api/health", "tcp GET /api/health"]);
  }, 30_000);

  it("finds its record and socket where the profile takes a state folder named through a link and `..`", async () => {
    const pc = profilePc();
    // `<link>/..` names the folder that holds the link, as the profile resolves its state folder (realpathSync), not
    // the parent of the link's target
    mkdirSync(join(pc.home, "sub", "deeper"), { recursive: true });
    symlinkSync(join(pc.home, "sub", "deeper"), join(pc.home, "via"));
    try {
      const status = await run("status", { ...pc.env, OVIS_STATE_DIR: `${join(pc.home, "via")}/../${basename(pc.state)}` });
      expect(status.out.split("\n")[0], status.err).toBe(`running http://127.0.0.1:${pc.port}`);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["socket GET /api/health"]);
  }, 30_000);

  it("takes its owner socket's refusal as the answer and does not ask the TCP port instead", async () => {
    const pc = profilePc({ door: 1 }, { owner: () => Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 }) });
    try {
      const status = await run("status", pc.env);
      const add = await run("add", pc.env);
      expect([status.out.split("\n")[0], add.err, add.exitCode]).toEqual([`down http://127.0.0.1:${pc.port}`, `Ovis is not running at http://127.0.0.1:${pc.port}; start it first\n`, 1]);
      printed(pc, status, add);
    } finally { await pc.stop(); }
    expect(pc.calls.map((call) => `${call.door} ${call.call}`)).toEqual(["socket GET /api/health", "socket GET /api/health"]);
  }, 30_000);

  const pairing = (path: string): Response | undefined => path === "/api/devices/pair/start" ? Response.json({ code: "123456", expires_at: new Date(Date.now() + 600_000).toISOString() })
    : path === "/api/access" ? Response.json({ tailscale: { state: "running", serving_url: null, serve_command: "tailscale serve --bg --https=7317 http://127.0.0.1:1" } }) : undefined;

  it("pair and phone-setup start no pairing on a running profile and show no address or Tailscale command: they name the relay's commands", async () => {
    const pc = profilePc({ door: 1 }, { owner: pairing });
    try {
      const pair = await run("pair", pc.env);
      const setup = await run("phone-setup", pc.env);
      for (const [label, ran, code] of [["pair", pair, 1], ["phone-setup", setup, 0]] as const) {
        const text = printed(pc, ran);
        expect([label, ran.exitCode, text.includes("link --code"), text.includes(" add "), text.includes("tailscale serve"), text.includes("open the app's address"), text.includes("Pairing code"), text.includes("App on this PC")]).toEqual([label, code, true, true, false, false, false, false]);
      }
    } finally { await pc.stop(); }
    expect(pc.calls).toEqual([]);
  }, 30_000);

  it("phone asks and changes nothing of Tailscale for a profile, and names the relay's commands", async () => {
    const pc = profilePc({ door: 1 }, { owner: pairing });
    const calls = join(scratch, "tailscale-calls");
    writeFileSync(join(scratch, "bin", "tailscale"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\ncase "$1 $2" in\n  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"pc.example.ts.net."}}' ;;\n  "serve status") echo '{}' ;;\nesac\n`);
    chmodSync(join(scratch, "bin", "tailscale"), 0o755);
    try {
      const phone = await run("phone", pc.env);
      const text = printed(pc, phone);
      expect([phone.exitCode, text.includes("link --code"), text.includes("tailscale serve"), existsSync(calls)]).toEqual([0, true, false, false]);
    } finally { await pc.stop(); }
    expect(pc.calls).toEqual([]);
  }, 30_000);

  it("start spawns nothing for a profile that does not answer, and exits 1; one that answers is reported running", async () => {
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(scratch, "spawned"))}, ""); process.exit(1);\n`);
    const absent = profilePc("");
    try {
      rmSync(join(absent.state, "serve.lock", "http.json"));
      absent.settings();
      writeFileSync(join(configDir, ".env"), `PORT=${quietPort()}\n`);
      const started = await run("start", { ...absent.env, HERDR_PLUGIN_ROOT: root }, { timeout: 20_000 });
      expect([started.exitCode, started.err.includes("ovis-server serve"), existsSync(join(scratch, "spawned")), existsSync(join(scratch, "state", "server.pid"))], started.out + started.err).toEqual([1, true, false, false]);
    } finally { await absent.stop(); }
    expect(absent.calls).toEqual([]);
    const running = profilePc();
    try {
      const started = await run("start", { ...running.env, HERDR_PLUGIN_ROOT: root }, { timeout: 20_000 });
      expect([started.exitCode, started.out.startsWith("Ovis already running at "), existsSync(join(scratch, "spawned"))], started.err).toEqual([0, true, false]);
    } finally { await running.stop(); }
  }, 60_000);

  it("reaches a real machine profile on its owner socket: status says it runs and add reads its account status there, and status says when its herdr is down", async () => {
    const { createServer } = await import("../server/index.ts");
    const { RelayService } = await import("../server/relay/service.ts");
    const { FakeAccountService } = await import("../shared/account-service-fake.ts");
    const state = join(walked(), "state");
    mkdirSync(state, { mode: 0o700 });
    const herdr = Bun.listen<{ line: string }>({ unix: join(scratch, "herdr.sock"), socket: {
      open(client) { client.data = { line: "" }; },
      data(client, chunk) {
        client.data.line += chunk.toString();
        if (!client.data.line.includes("\n")) return;
        const { id, method } = JSON.parse(client.data.line) as { id: string; method: string };
        if (method === "ping") client.write(`${JSON.stringify({ id, result: { version: "fixture", protocol: 22 } })}\n`);
      },
    } });
    const herdrSocket = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = join(scratch, "herdr.sock");
    const account = new FakeAccountService();
    // its port goes into the command's .env, so it is never one the guard refuses
    const server = offRealPorts(() => createServer({ profile: "machine", stateDir: state, port: 0, hostname: "127.0.0.1", tailscaleOwner: null, sidecar: false,
      relay: new RelayService({ stateDir: state, relay: "wss://relay.invalid" }), accountService: { url: "https://account.test", fetch: account.fetch } }));
    try {
      const socket = join(realpathSync(state), "serve.sock");
      mkdirSync(join(state, "serve.lock"));
      writeFileSync(join(state, "serve.lock", "http.json"), JSON.stringify({ port: server.port, hostname: "127.0.0.1", socket, door: 1 }));
      writeFileSync(join(configDir, ".env"), `PORT=${server.port}\nOVIS_PREVIEW=fleet\nOVIS_PROFILE=machine\n`);
      const env = { HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: state, OVIS_TOKEN: TOKEN, OVIS_ACCOUNT_SERVICE_URL: "https://account.test" };
      const status = await run("status", env);
      expect(status.out.split("\n")[0], status.err).toBe(`running http://127.0.0.1:${server.port}`);
      const add = await run("add", env, { args: ["--print"] });
      expect([add.out, add.exitCode], add.err).toEqual(["Adding this PC needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ovis add in a terminal (over ssh, run ssh -t).\n", 1]);
      printed({ socket }, status, add);
      herdr.stop(true);
      rmSync(join(scratch, "herdr.sock"), { force: true });
      const down = await run("status", env);
      expect(down.out.split("\n").slice(0, 2), down.err).toEqual([`running http://127.0.0.1:${server.port}`, "engine: down (herdr is not running for the selected session)"]);
      writeFileSync(join(state, "serve.lock", "http.json"), JSON.stringify({ port: server.port, hostname: "127.0.0.1", socket }));
      expect((await run("status", env)).out.split("\n")[0]).toBe(`down http://127.0.0.1:${server.port}`);
    } finally {
      await server.stop();
      herdr.stop(true);
      if (herdrSocket === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = herdrSocket;
    }
  }, 60_000);
});

describe("pair --approve", () => {
  function waitingPc() {
    const decisions: unknown[] = [];
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") return Response.json(APP_HEALTH);
      if (path === "/api/relay/pairings") return Response.json({ pairings: [{ id: "p1", label: "Phone one", digits: "111222" }, { id: "p2", label: "Phone two", digits: "333444" }] });
      if (path === "/api/relay/pairing") { decisions.push(await request.json()); return Response.json({ ok: true }); }
      return new Response(null, { status: 404 });
    } });
    return { server, decisions };
  }

  it("answers nothing with lines piped in, whatever they carry: it is not a terminal, so it says so and fails, and no request is declined", async () => {
    const { server, decisions } = waitingPc();
    try {
      const result = await run("pair", { PORT: String(server.port) }, { args: ["--approve"], stdin: "222\n444\n" });
      expect(result.exitCode, result.err).toBe(1);
      expect(result.out).toBe("This is not run in a terminal, so no request can be answered here. Nothing was declined: the requests keep waiting. Run this in a terminal to answer them (over ssh, run ssh -t).\n");
      expect(decisions).toEqual([]);
    } finally { await server.stop(true); }
  });

  /** `pair --approve` at a real terminal (script), against the Ovis on `port`: what it shows, and what is typed at it. */
  function atTerminal(port: number, extra: Record<string, string> = {}) {
    const env = launchEnv({ PORT: String(port), ...extra });
    // util-linux takes the command as one string, BSD (macOS) as arguments after the file it records to. Behind cat:
    // Bun hands a child a socket for stdin, which macOS's script refuses (tcgetattr), and cat gives it a pipe
    const command = platform() === "darwin" ? "script -q /dev/null bun scripts/plugin.ts pair --approve" : "script -qfec 'bun scripts/plugin.ts pair --approve' /dev/null";
    const child = Bun.spawn(["sh", "-c", `cat | ${command}`], { cwd: ROOT, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let screen = "";
    const reading = (async () => { for await (const chunk of child.stdout) screen += Buffer.from(chunk).toString(); })();
    return {
      child,
      get screen() { return screen; },
      type: (text: string): void => { child.stdin.write(text); child.stdin.flush(); },
      shows: async (text: string): Promise<void> => {
        const deadline = Date.now() + 20_000;
        while (!screen.includes(text)) {
          if (Date.now() > deadline) throw new Error(`the terminal never showed ${JSON.stringify(text)}: ${JSON.stringify(screen)}`);
          await Bun.sleep(25);
        }
      },
      close: async (): Promise<void> => {
        try { child.stdin.end(); } catch {}
        child.kill();
        await reading.catch(() => undefined);
      },
    };
  }

  it.skipIf(platform() === "win32" || Bun.which("script") === null)("discards what was typed at a real terminal before the question showed: digits begun ahead of it are no part of the Enter pressed at it", async () => {
    const decisions: unknown[] = [];
    let asked = (): void => undefined;
    const typedAhead = new Promise<void>((resolve) => { asked = resolve; });
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") return Response.json(APP_HEALTH);
      if (path === "/api/relay/pairings") { await typedAhead; return Response.json({ pairings: [{ id: "p1", label: "Phone one", digits: "111222" }] }); }
      if (path === "/api/relay/pairing") { decisions.push(await request.json()); return Response.json({ ok: true }); }
      return new Response(null, { status: 404 });
    } });
    const terminal = atTerminal(server.port!);
    try {
      terminal.type("222");
      await terminal.shows("222");
      asked();
      await terminal.shows("press Enter to decline: ");
      // fixed wait: a line counts only a second and a half after its question showed, by the command's own clock
      await Bun.sleep(1_700);
      terminal.type("\n");
      // kept, the digits would head the line this Enter sends and approve the request; discarded, the line is empty
      await terminal.shows("Declined.");
      expect(decisions).toEqual([{ id: "p1", decision: "decline" }]);
      expect(terminal.screen).not.toContain("That line answered nothing");
      terminal.child.stdin.end();
      expect(await terminal.child.exited).toBe(0);
    } finally {
      await terminal.close();
      await server.stop(true);
    }
  }, 40_000);

  /** A PC with a members-only account join waiting (#28): `refusal` answers every relay read, as a locked PC does. */
  function joinWaitingPc(options: { refusal?: "locked" | "strict"; answer?: Response } = {}) {
    const typed: { body: unknown; machine: string | null }[] = [];
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") return Response.json(APP_HEALTH);
      if (options.refusal !== undefined && path.startsWith("/api/relay/")) return Response.json({ error: { code: options.refusal, message: "refused" } }, { status: 403 });
      if (path === "/api/relay/pairings") return Response.json({ pairings: [] });
      if (path === "/api/relay/joins") return Response.json({ joins: [{ id: "j1", label: "Galaxy Tab", asked_at: new Date().toISOString(), left_ms: 60_000 }] });
      if (path === "/api/relay/join") { typed.push({ body: await request.json(), machine: request.headers.get("x-herdr-machine") }); return options.answer ?? Response.json({ ok: true }); }
      return new Response(null, { status: 404 });
    } });
    return { server, typed };
  }

  it.skipIf(platform() === "win32" || Bun.which("script") === null)("#28: lists a members join and lets it in with the six digits typed at the terminal, through this PC's own route", async () => {
    const { server, typed } = joinWaitingPc();
    const terminal = atTerminal(server.port!);
    try {
      await terminal.shows("Galaxy Tab");
      await terminal.shows(": ");
      // fixed wait: a line counts only a second and a half after its question showed, by the command's own clock
      await Bun.sleep(1_700);
      terminal.type("123456\n");
      await terminal.shows("Approved");
      expect(typed).toEqual([{ body: { id: "j1", digits: "123456" }, machine: "1" }]);
      terminal.child.stdin.end();
      expect(await terminal.child.exited).toBe(0);
    } finally {
      await terminal.close();
      await server.stop(true);
    }
  }, 40_000);

  it("#28: approves no members join with lines piped in: it says it is not a terminal, fails, and types nothing", async () => {
    const { server, typed } = joinWaitingPc();
    try {
      const result = await run("pair", { PORT: String(server.port) }, { args: ["--approve"], stdin: "123456\n" });
      expect(result.exitCode, result.err).toBe(1);
      expect(result.out).toContain("not run in a terminal");
      expect(typed).toEqual([]);
    } finally { await server.stop(true); }
  });

  it("#28: refuses on a locked or strict PC and says so", async () => {
    for (const refusal of ["locked", "strict"] as const) {
      const { server, typed } = joinWaitingPc({ refusal });
      try {
        const result = await run("pair", { PORT: String(server.port) }, { args: ["--approve"], stdin: "123456\n" });
        expect(result.exitCode).toBe(1);
        expect(result.out + result.err).toContain(refusal === "locked" ? "This PC is locked" : "safety log");
        expect(typed).toEqual([]);
      } finally { await server.stop(true); }
    }
  });

  /**
   * A PC added in one press, with no member yet, that the first device opening it asks to join: a first join, which
   * comes with its digits for this PC's own window (GET /api/relay/joins) and which only this PC may let in.
   */
  function firstJoinWaitingPc(answer: (body: { id: string; digits: string }) => Response | undefined = () => undefined) {
    const typed: unknown[] = [];
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") return Response.json(APP_HEALTH);
      if (path === "/api/relay/pairings") return Response.json({ pairings: [] });
      if (path === "/api/relay/joins") {
        return Response.json({ joins: [
          { id: "f1", label: "Pixel", asked_at: FIRST_ASKED_AT, left_ms: 80_000, digits: "482913" },
          { id: "f2", label: "Galaxy", asked_at: FIRST_ASKED_AT, left_ms: 80_000, digits: "555666" },
        ] });
      }
      if (path === "/api/account/status") return Response.json({ account: "acct_1a2b3c4d5e6f", members: 0 });
      if (path === "/api/relay/join") {
        const body = await request.json() as { id: string; digits: string };
        typed.push(body);
        return answer(body) ?? Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    } });
    return { server, typed };
  }
  const FIRST_ASKED_AT = "2026-11-24T09:41:00.000Z";
  // the command names the time on this PC's clock: UTC here, for the child as for the test
  const firstAsked = (label: string) => `${label} asks to open this PC (from Ovis account acct_1a2b3c4, asked at 09:41)`;

  it.skipIf(platform() === "win32" || Bun.which("script") === null)("lets a first join in with the six digits its device shows typed at the terminal, naming the device, its account and when it asked, and showing none of the digits", async () => {
    const { server, typed } = firstJoinWaitingPc();
    const terminal = atTerminal(server.port!, { TZ: "UTC" });
    try {
      await terminal.shows(`${firstAsked("Pixel")}. Type the six digits Pixel shows (one wrong entry ends this request), or press Enter to skip: `);
      expect(terminal.screen).not.toMatch(/482|913/);
      // fixed wait: a line counts only a second and a half after its question showed, by the command's own clock
      await Bun.sleep(1_700);
      terminal.type("482913\n");
      await terminal.shows("Pixel is let in; it opens this PC in a moment.");
      await terminal.shows("Galaxy shows (one wrong entry ends this request), or press Enter to skip: ");
      // fixed wait: as above, for the next question
      await Bun.sleep(1_700);
      terminal.type("\n");
      await terminal.shows("Galaxy is left waiting until its time runs out.");
      expect(typed).toEqual([{ id: "f1", digits: "482913" }]);
      terminal.child.stdin.end();
      expect(await terminal.child.exited).toBe(0);
    } finally {
      await terminal.close();
      await server.stop(true);
    }
  }, 40_000);

  it.skipIf(platform() === "win32" || Bun.which("script") === null)("says so when the digits typed for a first join are not its device's, which ends that join here", async () => {
    const { server, typed } = firstJoinWaitingPc((body) => body.id === "f1" ? Response.json({ error: { code: "wrong_digits", message: "Those are not the digits the new device shows; it was not let in." } }, { status: 409 }) : undefined);
    const terminal = atTerminal(server.port!);
    try {
      await terminal.shows("Pixel shows (one wrong entry ends this request), or press Enter to skip: ");
      // fixed wait: a line counts only a second and a half after its question showed, by the command's own clock
      await Bun.sleep(1_700);
      terminal.type("000000\n");
      await terminal.shows("That is not the number Pixel shows, so it was not let in. To try again, have Pixel ask again, then run ovis approve again.");
      expect(terminal.screen).not.toContain("Pixel is let in");
      expect(typed).toEqual([{ id: "f1", digits: "000000" }]);
    } finally {
      await terminal.close();
      await server.stop(true);
    }
  }, 40_000);

  it("lists a first join where its input is not a terminal, with the way to let it in, and approves nothing", async () => {
    const { server, typed } = firstJoinWaitingPc();
    try {
      const result = await run("pair", { PORT: String(server.port), TZ: "UTC" }, { args: ["--approve"], stdin: "482913\n" });
      expect(result.exitCode, result.err).toBe(1);
      expect(result.out).toContain(`${firstAsked("Pixel")}. Run ovis approve in a terminal on this PC and type the six digits Pixel shows.\n`);
      expect(result.out).toContain("This is not run in a terminal");
      expect(result.out).not.toContain("No device is waiting");
      expect(typed).toEqual([]);
    } finally { await server.stop(true); }
  });

  it("says so when no device waits", async () => {
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      return path === "/api/health" ? Response.json(APP_HEALTH) : path === "/api/relay/pairings" ? Response.json({ pairings: [] }) : new Response(null, { status: 404 });
    } });
    try {
      const result = await run("pair", { PORT: String(server.port) }, { args: ["--approve"], stdin: "" });
      expect([result.out, result.exitCode], result.err).toEqual(["No device is waiting to pair.\n", 0]);
    } finally { await server.stop(true); }
  });
});

/**
 * A fake clock for the command's time limits, loaded before it runs: `AbortSignal.timeout(ms)` arms a limit instead of
 * timing one, each request names the limit it carries (`x-test-limit`), and an answer marked `x-test-past-limit` moves
 * the clock past that request's limit as it comes in, so its body is never read in time.
 */
const FAKE_CLOCK = `
const armed = new WeakMap();
AbortSignal.timeout = (ms) => { const controller = new AbortController(); armed.set(controller.signal, { ms, controller }); return controller.signal; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const limit = init.signal ? armed.get(init.signal) : undefined;
  const headers = new Headers(init.headers);
  if (limit) headers.set("x-test-limit", String(limit.ms));
  const response = await realFetch(input, { ...init, headers });
  if (limit && response.headers.get("x-test-past-limit") === "1") limit.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  return response;
};
`;

/**
 * A server that answers health, and `late` past the limit its request carries: `late` is reached (its `reached` runs)
 * and answered, but its body would come only after the clock passed the limit. `limits`: the limit each request carried.
 */
function lateAnswerPc(late: string, answer: (path: string) => Response | undefined = () => undefined, reached = (): void => undefined) {
  const limits: Record<string, string | null> = {};
  const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    limits[path] = request.headers.get("x-test-limit");
    if (path === "/api/health") return Response.json(APP_HEALTH);
    if (path === late) {
      reached();
      return new Response(new ReadableStream({ start(body) { body.enqueue(new TextEncoder().encode("{")); } }), { headers: { "content-type": "application/json", "x-test-past-limit": "1" } });
    }
    return answer(path) ?? new Response(null, { status: 404 });
  } });
  return { server, limits };
}

describe("pair's first requests to a server that answered health", () => {
  const clocked = () => { const file = join(scratch, "fake-clock.ts"); writeFileSync(file, FAKE_CLOCK); return file; };

  it("pair --approve gives up on the waiting pairings at the 15 s its later reads have, and says so", async () => {
    const pc = lateAnswerPc("/api/relay/pairings");
    try {
      const result = await run("pair", { PORT: String(pc.server.port) }, { args: ["--approve"], stdin: "", timeout: 10_000, preload: clocked() });
      expect([result.exitCode, result.out], result.err).toEqual([1, ""]);
      expect(pc.limits["/api/relay/pairings"]).toBe("15000");
      expect(result.err).toBe(`Ovis at http://127.0.0.1:${pc.server.port} did not answer in time; try again\n`);
    } finally { await pc.server.stop(true); }
  }, 20_000);

  it("pair gives up on starting a pairing at the 5 s its relay requests have, and says a code it never got may be live", async () => {
    let made = 0;
    const pc = lateAnswerPc("/api/devices/pair/start", undefined, () => { made++; });
    try {
      const result = await run("pair", { PORT: String(pc.server.port), OVIS_CLI_NAME: undefined }, { timeout: 10_000, preload: clocked() });
      expect([result.exitCode, result.out], result.err).toEqual([1, ""]);
      expect(pc.limits["/api/devices/pair/start"]).toBe("5000");
      // the PC made a code this never showed: the command says so, and names the run that replaces it
      expect(made).toBe(1);
      expect(result.err).toContain("run ovis pair again");
    } finally { await pc.server.stop(true); }
  }, 20_000);

  it("pair shows its code without an address when the address does not come within 5 s", async () => {
    const pc = lateAnswerPc("/api/access", (path) => path === "/api/devices/pair/start" ? Response.json({ code: "123456", expires_at: "2030-01-01T00:00:00.000Z" }) : undefined);
    try {
      const result = await run("pair", { PORT: String(pc.server.port) }, { timeout: 10_000, preload: clocked() });
      expect(result.exitCode, result.err).toBe(0);
      expect(pc.limits["/api/access"]).toBe("5000");
      expect(result.out).toContain("Pairing code: 123 456");
      expect(result.out).toContain("open the app's address");
    } finally { await pc.server.stop(true); }
  }, 20_000);
});

describe("pair relay offer", () => {
  async function pairWithRelay(phase: "online" | "off" | "missing" | "malformed" | "bad-offer") {
    const key = generateKeyPair();
    let offerRequests = 0;
    let validOfferUrl = "";
    const server = serveOffRealPorts({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/health") return Response.json(APP_HEALTH);
        if (path === "/api/devices/pair/start") return Response.json({ code: "123456", expires_at: "2030-01-01T00:00:00.000Z" });
        if (path === "/api/access") return Response.json({ tailscale: { serving_url: null } });
        if (path === "/api/relay") {
          if (phase === "missing") return new Response("not found", { status: 404 });
          if (phase === "malformed") return new Response("{", { headers: { "content-type": "application/json" } });
          return Response.json({ phase: phase === "bad-offer" ? "online" : phase });
        }
        if (path === "/api/relay/offer") {
          offerRequests++;
          expect(request.method).toBe("POST");
          expect(request.headers.get("x-herdr-update")).toBe("1");
          expect(request.headers.get("origin")).toBe(`http://127.0.0.1:${server.port}`);
          if (phase === "bad-offer") return Response.json({ url: "https://app.ovis.sh/#offer=not-valid" });
          validOfferUrl = encodeOffer({
            v: 1, server_id: "0123456789abcdef0123456789abcdef",
            server_public_key: exportPublicKey(key.publicKey), relay: "wss://relay.ovis.sh", code: "123456",
          }, "https://app.ovis.sh");
          return Response.json({ url: validOfferUrl, expires_at: "2030-01-01T00:00:00.000Z" });
        }
        return new Response(null, { status: 404 });
      },
    });
    try {
      const result = await run("pair", { PORT: String(server.port) });
      return { ...result, offerRequests };
    } finally {
      await server.stop(true);
    }
  }

  it("prints the relay offer URL and QR only while online", async () => {
    const result = await pairWithRelay("online");
    expect(result.exitCode, result.err).toBe(0);
    expect(result.out).toContain("Ovis relay");
    const printedUrl = result.out.split("\n").find((line) => line.includes("#offer="));
    expect(printedUrl).toBeString();
    const offer = decodeOffer(printedUrl!);
    expect(offer?.code).toBe("123456");
    const printedCode = /Pairing code: (\d{3}) (\d{3})/.exec(result.out);
    expect(printedCode?.[1] + printedCode?.[2]).toBe(offer?.code);
    expect(result.out.slice(result.out.indexOf(printedUrl!) + printedUrl!.length)).toContain("█");
    expect(result.offerRequests).toBe(1);
  });

  it("prints one settings hint while relay is off and never requests an offer", async () => {
    const result = await pairWithRelay("off");
    expect(result.exitCode, result.err).toBe(0);
    expect(result.out).not.toContain("#offer=");
    expect(result.out.match(/To turn on Ovis relay:/g)).toHaveLength(1);
    expect(result.offerRequests).toBe(0);
  });

  it("prints nothing extra when the relay API is missing", async () => {
    const result = await pairWithRelay("missing");
    expect(result.exitCode, result.err).toBe(0);
    expect(result.out).not.toContain("Ovis relay");
    expect(result.out).not.toContain("To turn on Ovis relay:");
    expect(result.offerRequests).toBe(0);
  });

  it("reports malformed relay responses without crashing or printing a QR", async () => {
    const status = await pairWithRelay("malformed");
    expect(status.exitCode).toBe(0);
    expect(status.err).toContain("Could not read Ovis relay pairing:");
    expect(status.out).not.toContain("#offer=");
    const offer = await pairWithRelay("bad-offer");
    expect(offer.exitCode).toBe(0);
    expect(offer.err).toContain("Could not read Ovis relay pairing:");
    expect(offer.out).not.toContain("#offer=");
  });
});

describe("a command handed on to the release the app updated to", () => {
  // POSIX signals: on Windows herdr runs scripts/plugin.ps1, no SIGTERM or SIGHUP reaches the plugin there, and a SIGINT
  // is not passed on
  const posix = it.skipIf(process.platform === "win32");
  const plugin = JSON.stringify(join(ROOT, "scripts", "plugin.ts"));
  const releaseScript = join("release-test", "scripts", "plugin.ts");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function within<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), 10_000); })]);
    } finally { clearTimeout(timer); }
  }

  /**
   * With `group`, it leads a process group of its own, as a command
   * in a terminal does. Its stderr goes into a file: a release left running would hold a pipe open.
   */
  function handOn(command: string, { fail = false, group = false, given = join(scratch, "app-state"), settings = "" } = {}) {
    const port = quietPort();
    writeFileSync(join(configDir, ".env"), `PORT=${port}\n${settings}`);
    const release = join(updateStateDir(ROOT, port, join(scratch, "app-state")), "release-test");
    mkdirSync(join(release, "scripts"), { recursive: true });
    const pidFile = join(scratch, "release-pid");
    writeFileSync(join(release, "scripts", "plugin.ts"), `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => process.exit(3));
process.on("SIGHUP", () => process.exit(4));
process.on("SIGINT", () => process.exit(6));
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log("up");
setInterval(() => {}, 1 << 30);
`);
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true }).stdout.toString().trim();
    writeFileSync(join(release, "..", "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
    const notes = join(scratch, "notes");
    const releaseEnv = join(scratch, "release-env");
    const child = Bun.spawn([process.execPath, "-e", `import { appendFileSync } from "node:fs";
const spawn = Bun.spawn;
Bun.spawn = (argv, options) => {
  if (!String(argv[1]).endsWith(${JSON.stringify(releaseScript)})) return spawn(argv, options);
  appendFileSync(${JSON.stringify(notes)}, \`spawn \${process.listenerCount("SIGTERM")} \${process.listenerCount("SIGHUP")}\n\`);
  appendFileSync(${JSON.stringify(releaseEnv)}, JSON.stringify({ state: options.env.OVIS_STATE_DIR, given: options.env.OVIS_PLUGIN_GIVEN_STATE_DIR }));
  ${fail ? "throw new Error(\"the release cannot start\");" : "return spawn(argv, options);"}
};
process.argv = [process.execPath, ${plugin}, ${JSON.stringify(command)}];
const { runPlugin } = await import(${plugin});
try { await runPlugin(); } catch (error) { appendFileSync(${JSON.stringify(notes)}, \`threw \${error.message}\n\`); }
process.kill(process.pid, "SIGTERM");
setInterval(() => {}, 1_000);`], {
      cwd: ROOT, stdout: "pipe", stderr: Bun.file(join(scratch, "stderr")), detached: group,
      env: launchEnv({ HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: given, OVIS_TOKEN: "" }),
    });
    const released = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    return {
      child, released,
      notes: () => existsSync(notes) ? readFileSync(notes, "utf8") : "",
      releaseEnv: () => existsSync(releaseEnv) ? JSON.parse(readFileSync(releaseEnv, "utf8")) as unknown : null,
      said: () => existsSync(join(scratch, "stderr")) ? readFileSync(join(scratch, "stderr"), "utf8") : "",
      [Symbol.dispose]: () => {
        child.kill("SIGKILL");
        if (released() > 0 && alive(released())) process.kill(released(), "SIGKILL");
      },
    };
  }

  posix("gives the release the environment the settings file made, and the OVIS_STATE_DIR it was run with apart", async () => {
    using run = handOn("a-later-command", { given: join(scratch, "given-state"), settings: `OVIS_STATE_DIR=${join(scratch, "app-state")}\n` });
    const up = await within(run.child.stdout.getReader().read(), "the release never started");
    expect(new TextDecoder().decode(up.value), run.said()).toBe("up\n");
    expect(run.releaseEnv()).toEqual({ state: join(scratch, "app-state"), given: join(scratch, "given-state") });
  }, 30_000);

  for (const command of ["link", "phone-setup", "a-later-command"]) {
    for (const [signal, exit] of [["SIGTERM", 3], ["SIGHUP", 4], ["SIGINT", 6]] as const) {
      posix(`${command}: listens before the release starts, passes it a ${signal} and exits as it did, leaving no release behind`, async () => {
        using run = handOn(command);
        const up = await within(run.child.stdout.getReader().read(), "the release never started");
        expect(new TextDecoder().decode(up.value)).toBe("up\n");
        run.child.kill(signal);
        const code = await within(run.child.exited, "the command never exited");
        expect({ notes: run.notes(), code, releaseLeft: alive(run.released()) }, run.said()).toEqual({ notes: "spawn 1 1\n", code: exit, releaseLeft: false });
      }, 30_000);
    }

    posix(`${command}: ends with the release on a Ctrl+C, which reaches both through their process group`, async () => {
      // the terminal's SIGINT goes to the whole group: the release gets it directly and, passed on, once more
      using run = handOn(command, { group: true });
      const up = await within(run.child.stdout.getReader().read(), "the release never started");
      expect(new TextDecoder().decode(up.value)).toBe("up\n");
      process.kill(-run.child.pid, "SIGINT");
      const code = await within(run.child.exited, "the command never exited");
      expect({ code, releaseLeft: alive(run.released()) }, run.said()).toEqual({ code: 6, releaseLeft: false });
    }, 30_000);

    posix(`${command}: stops listening when the release cannot be started, so a later SIGTERM ends the process as it would`, async () => {
      using run = handOn(command, { fail: true });
      await within(run.child.exited, "the command never exited");
      expect({ notes: run.notes(), signal: run.child.signalCode }, run.said()).toEqual({ notes: "spawn 1 1\nthrew the release cannot start\n", signal: "SIGTERM" });
    }, 30_000);
  }
});

describe("a checkout whose packages are not installed", () => {
  /**
   * Every file of the checkout plugin.ts can load, at any command, copied without the packages into an empty
   * node_modules, where Bun installs nothing on its own: what an install cut off before it got to them leaves.
   */
  async function withoutPackages(): Promise<string> {
    const copy = join(scratch, "checkout");
    const built = await Bun.build({ entrypoints: [join(ROOT, "scripts", "plugin.ts")], target: "bun", packages: "external", metafile: true });
    for (const input of Object.keys(built.metafile!.inputs)) {
      const to = join(copy, relative(ROOT, resolve(input)));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(resolve(input), to);
    }
    mkdirSync(join(copy, "node_modules"));
    return copy;
  }

  async function runIn(copy: string, args: string[], port: number): Promise<{ out: string; err: string; code: number }> {
    const child = Bun.spawn([process.execPath, join("scripts", "plugin.ts"), ...args], {
      cwd: copy, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: launchEnv({ PORT: String(port), HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: copy, HERDR_PLUGIN_CONFIG_DIR: configDir, OVIS_STATE_DIR: join(scratch, "app-state"), OVIS_TOKEN: "" }),
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }

  it("stop and status load and answer", async () => {
    const copy = await withoutPackages();
    const port = quietPort();
    for (const [command, said] of [["status", `down http://127.0.0.1:${port}\n`], ["stop", "Ovis is not running\n"]] as const) {
      const { out, err, code } = await runIn(copy, [command], port);
      expect({ command, code, first: out.split("\n")[0] + "\n" }, err).toEqual({ command, code: 0, first: said });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("the commands that need a package fail before they change anything: no pairing code asked for, nothing published or decided", async () => {
    const copy = await withoutPackages();
    const changes: string[] = [];
    const server = serveOffRealPorts({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") changes.push(`${request.method} ${path}`);
      if (path === "/api/health") return Response.json(APP_HEALTH);
      if (path === "/api/access") return Response.json({ tailscale: { serving_url: "https://pc.example.ts.net", serve_command: null } });
      if (path === "/api/devices/pair/start") return Response.json({ code: "123456", expires_at: new Date(Date.now() + 600_000).toISOString() });
      if (path === "/api/relay/pairings") return Response.json({ pairings: [] });
      return new Response(null, { status: 404 });
    } });
    const calls = join(scratch, "tailscale-calls");
    writeFileSync(join(scratch, "bin", "tailscale"), `#!/bin/sh
echo "$*" >> ${JSON.stringify(calls)}
case "$1 $2" in
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"pc.example.ts.net."}}' ;;
  "serve status") echo '{}' ;;
esac
`);
    chmodSync(join(scratch, "bin", "tailscale"), 0o755);
    try {
      for (const args of [["pair"], ["phone-setup"], ["phone"], ["link"], ["pair", "--approve"]]) {
        const { err, code } = await runIn(copy, args, server.port!);
        expect({ args, failed: code !== 0, missing: /Cannot find (package|module)/.test(err) }, err).toEqual({ args, failed: true, missing: true });
      }
      // regression (fails at 69ebe4b1: pair and phone-setup asked for a pairing code, which replaces the one another
      // device may be using, and phone published the app, before each failed at the package)
      const published = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith("serve --yes")) : [];
      expect({ changes, published }).toEqual({ changes: [], published: [] });
    } finally {
      await server.stop(true);
    }
  }, 60_000);
});
