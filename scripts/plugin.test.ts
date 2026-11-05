import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { platform, tmpdir, uptime } from "node:os";
import { join } from "node:path";

import { herdrStateDir } from "./plugin-state.ts";
import { readProcessBirth } from "../server/process-owner.ts";
import { updateStateDir } from "../server/update-state.ts";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";

/**
 * The plugin's settings files, read by hand the way a headless PC runs `status` or `pair`:
 * no HERDR_PLUGIN_CONFIG_DIR, so the script asks herdr (a fake one here) for the config dir.
 */

const ROOT = join(import.meta.dir, "..");
let scratch: string;
let configDir: string;

async function status(): Promise<{ out: string; err: string; exitCode: number }> {
  return run("status");
}

async function run(command: string, extra: Record<string, string | undefined> = {}): Promise<{ out: string; err: string; exitCode: number }> {
  const child = launch(command, extra);
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, exitCode };
}

function launch(command: string, extra: Record<string, string | undefined> = {}) {
  const bin = join(scratch, "bin");
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: scratch, HERDR_PLUGIN_STATE_DIR: join(scratch, "state") };
  for (const key of ["HERDR_PLUGIN_CONFIG_DIR", "PORT", "HOST", "OVIS_TOKEN", "OVIS_STATE_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]) delete env[key];
  Object.assign(env, extra);
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return Bun.spawn(["bun", "scripts/plugin.ts", command], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
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

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

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

/** What the app's bridge health answers (server/index.ts): it holds the port whether herdr answers or not. */
const BRIDGE_HEALTH = { ok: true, auth: { required: false, authenticated: true }, bridge_protocol: 1 };
/** What the app's full health answers while herdr does (every release since v0.1.0 has sent these). */
const APP_HEALTH = { ok: true, herdr: { version: "0.9.3", protocol: 1 }, auth: { required: false, authenticated: true } };

describe("the herdr socket", () => {
  /** a stand-in server that records the HERDR_SOCKET it was started with, then exits */
  const socketSeen = async (): Promise<string> => {
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(scratch, "seen"))}, process.env.HERDR_SOCKET ?? "unset");\n`);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = probe.port;
    await probe.stop(true);
    await run("start", { HERDR_PLUGIN_ROOT: root, HERDR_SOCKET_PATH: "/herdr/own.sock", PORT: String(port) });
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
  /** starts a stand-in server that runs `body` and exits before it answers, so the start fails */
  const failedStart = async (body: string) => {
    const root = join(scratch, "root");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "managed.ts"), `${body}\nprocess.exit(1);\n`);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = probe.port;
    await probe.stop(true);
    return run("start", { HERDR_PLUGIN_ROOT: root, PORT: String(port) });
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
    // this test's own process stands in for a server that is still running
    writeFileSync(state("server.pid"), `${process.pid}\n`);
    await failedStart(`console.log("this run");`);
    expect(readFileSync(state("server.log"), "utf8")).toStartWith("live run\nthis run\n");
    expect(existsSync(state("server.log.1"))).toBe(false);
  });

  /** the lines a failed start showed from the log */
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
    // each stand-in server reports its pid here, then binds only once the test says go: both starts
    // decide while the first one's server has not taken the port yet
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
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = String(probe.port);
    await probe.stop(true);
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
      /** reads the second start's output until it says `text`, or to its end */
      const readSecond = async (text?: string) => {
        while (text === undefined || !secondOut.includes(text)) {
          const { value, done } = await reader.read();
          if (done) return;
          secondOut += decoder.decode(value, { stream: true });
        }
      };
      // the second start either waits for the first or (the bug) opens a server of its own
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
      for (const { pid } of servers) try { process.kill(-pid, "SIGKILL"); } catch { /* stopped */ }
      listener.stop(true);
    }
  }, 60_000);

  /** a recorded server (a sleep) on a free port, and a root whose stand-in server marks that it was spawned */
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
  const freePortNumber = async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = String(probe.port);
    await probe.stop(true);
    return port;
  };

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

  // a recorded server that exited while its parent (a plugin host, say) has not reaped it yet
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
    // a server started under the old id runs; herdr hands the updated plugin the new id's dir. A
    // start and a stop that read the record in different dirs must still share one lock
    const plugins = join(scratch, "plugins");
    const legacy = join(plugins, "devswha.herdr-web-ui");
    const current = join(plugins, "devswha.ovis");
    mkdirSync(legacy, { recursive: true });
    const server = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      writeFileSync(join(legacy, "server.pid"), `${server.pid}\n`);
      const stopped = await run("stop", { HERDR_PLUGIN_STATE_DIR: current, PORT: "1" });
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(existsSync(join(current, "lifecycle.lock.guard"))).toBe(true);
      expect(existsSync(join(legacy, "lifecycle.lock.guard")), "regression: the lock followed the record into the old id's dir").toBe(false);
    } finally {
      try { process.kill(-server.pid!, "SIGKILL"); } catch { /* stopped */ }
    }
  });

  it("keep a server whose birth matches though the clock stepped forward past the record", async () => {
    // the wall clock jumped (NTP on a PC without a clock of its own, a resumed VM): the record now
    // looks older than this boot, though the very process it names runs
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
    } finally { try { process.kill(-server.pid!, "SIGKILL"); } catch { /* stopped */ } }
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
    // written an hour before this boot: whatever holds its pid now is another process
    const beforeBoot = (Date.now() - uptime() * 1000) / 1000 - 3600;
    utimesSync(owner, beforeBoot, beforeBoot);
    try {
      await run("start", { HERDR_PLUGIN_ROOT: root, PORT: await freePortNumber() });
      expect(existsSync(join(scratch, "spawned"))).toBe(true);
    } finally { process.kill(-server.pid!, "SIGKILL"); }
  });

  /** Another process holding the lifecycle lock (or, with `guardOnly`, only its native guard, as one stopped mid-acquisition would) until released. */
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
  /** Reads a process's output until it says `text`, within 15 s; what it said so far. */
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
    const ours = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(APP_HEALTH) });
    const { server, root } = recordedSleeper((pid) => { const reading = readProcessBirth(pid); return reading.state === "identified" ? reading.birth : null; });
    // the start waits behind the other, which then moves to another port, records its server and comes up there
    rmSync(join(scratch, "state", "server.pid"));
    try {
      const start = launch("start", { HERDR_PLUGIN_ROOT: root });
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
    mkdirSync(join(scratch, "state", "server.owner"), { recursive: true }); // a path that cannot take the record
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
    } finally { if (pid > 0) try { process.kill(-pid, "SIGKILL"); } catch { /* stopped */ } }
  }, 30_000);

  it("start a server when the recorded pid now runs another process", async () => {
    // the birth kept for the record is not the one running under its pid: the pid was handed on
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
    expect((await status()).out).toContain("down http://127.0.0.1:3");
  });

  it("lets a PORT the user set win over the kept one", async () => {
    keep(3);
    writeFileSync(join(configDir, ".env"), "PORT=1\n");
    expect((await status()).out).toContain("down http://127.0.0.1:1");
  });

  it("does not start on another port when the PORT the user set cannot be opened, and says so", async () => {
    // holds the port without answering as the app would
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
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
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>not us</html>", { headers: { "content-type": "text/html" } }) });
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
      const stranger = Bun.serve({
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
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      writeFileSync(join(configDir, ".env"), `PORT=${stranger.port}\n`);
      const started = await run("start");
      expect(started.out).not.toContain("already running");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`port ${stranger.port} on 127.0.0.1 cannot be opened`);
    } finally { await stranger.stop(true); }
  });

  it("follows a start that is coming up on another port instead of opening a second server", async () => {
    // the app answers on the port the other start fell back to
    const ours = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(APP_HEALTH) });
    // the kept port is held by someone else; its first health probe is the moment the other start writes its choice
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { keep(ours.port!); return new Response(null, { status: 404 }); } });
    try {
      keep(stranger.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`); // the other start's record, alive
      const started = await run("start");
      expect(started.out).toContain(`already running at http://127.0.0.1:${ours.port}`);
      expect(started.exitCode).toBe(0);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${process.pid}\n`);
      expect(readFileSync(join(scratch, ".config", "ovis", "plugin-port"), "utf8")).toBe(`${ours.port}\n`);
    } finally { await Promise.all([ours.stop(true), stranger.stop(true)]); }
  });

  it("keeps the port of its own server that cannot reach herdr instead of moving the app (#428)", async () => {
    // the app answers its bridge health, but the full one fails as it does while herdr is away
    const ours = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new URL(request.url).searchParams.get("scope") === "bridge"
        ? Response.json(BRIDGE_HEALTH)
        : Response.json({ error: { code: "connect_failed", message: "herdr socket unreachable" } }, { status: 502 }),
    });
    try {
      keep(ours.port!);
      mkdirSync(join(scratch, "state"), { recursive: true });
      writeFileSync(join(scratch, "state", "server.pid"), `${process.pid}\n`); // the start that runs it, alive
      // a start that moves anyway spawns no real server: there is no server/managed.ts under this root
      const started = await run("start", { HERDR_PLUGIN_ROOT: scratch });
      expect(started.out).not.toContain("instead");
      expect(started.exitCode).toBe(1);
      expect(started.err).toContain(`Ovis is running at http://127.0.0.1:${ours.port} (pid ${process.pid}) but cannot reach herdr: herdr socket unreachable`);
      expect(readFileSync(join(scratch, ".config", "ovis", "plugin-port"), "utf8")).toBe(`${ours.port}\n`);
      expect(readFileSync(join(scratch, "state", "server.pid"), "utf8")).toBe(`${process.pid}\n`);
    } finally { await ours.stop(true); }
  }, 40_000);

  it("reports its own server as running when herdr comes back while start asks why it cannot reach it", async () => {
    // herdr is away through the wait and the check after the bridge probe, and back for the question after that
    let afterBridge = -1;
    const ours = Bun.serve({
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
      const started = await run("start", { HERDR_PLUGIN_ROOT: scratch });
      expect(started.err).not.toContain("cannot reach herdr");
      expect(started.exitCode).toBe(0);
      expect(started.out).toContain(`Ovis already running at http://127.0.0.1:${ours.port}`);
    } finally { await ours.stop(true); }
  }, 40_000);
});

describe("stop", () => {
  it("stops the server an install started under its old id after herdr updated the plugin to the new id", async () => {
    // herdr hands the updated plugin plugins/devswha.ovis while the running server's record is under devswha.herdr-web-ui
    const plugins = join(scratch, "plugins");
    const legacy = join(plugins, "devswha.herdr-web-ui");
    mkdirSync(legacy, { recursive: true });
    const server = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      writeFileSync(join(legacy, "server.pid"), `${server.pid}\n`);
      const stopped = await run("stop", { HERDR_PLUGIN_STATE_DIR: join(plugins, "devswha.ovis"), PORT: "1" });
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(existsSync(join(legacy, "server.pid"))).toBe(false);
      expect(() => process.kill(server.pid!, 0)).toThrow();
    } finally {
      try { process.kill(-server.pid!, "SIGKILL"); } catch { /* already stopped */ }
    }
  });

  it("does not signal a process that took the recorded server's pid", async () => {
    // the server recorded here had another birth: the process under its pid now is someone else's
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
      try { process.kill(-other.pid!, "SIGKILL"); } catch { /* stopped */ }
    }
  });

  it("returns only once the server's process group is gone", async () => {
    // a server that takes a second to exit, as the supervisor does while its bridge shuts down
    const server = spawn("sh", ["-c", "trap 'sleep 1; exit 0' TERM; while :; do sleep 0.1; done"], { detached: true, stdio: "ignore" });
    const pid = server.pid!;
    mkdirSync(join(scratch, "state"));
    writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
    const started = Date.now();
    const stopped = await run("stop");
    expect(stopped.exitCode, stopped.err).toBe(0);
    expect(stopped.out).toContain(`stopped Ovis (pid ${pid})`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
  });

  // a server that exited while its parent (a plugin host, say) has not reaped it yet
  it.skipIf(platform() !== "linux" || !Bun.which("setsid"))("counts an exited, unreaped server as gone", async () => {
    // the inner shell leads its own group; its parent turns into a sleep that never reaps it
    const parent = spawn("sh", ["-c", `setsid sh -c 'echo $$; exec sleep 0.2' & exec sleep 30`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const pid = Number(await new Promise<string>((resolve) => parent.stdout!.once("data", (chunk) => resolve(String(chunk).trim()))));
      const state = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      const deadline = Date.now() + 5_000;
      while (state() !== "Z" && Date.now() < deadline) await Bun.sleep(20);
      expect(state()).toBe("Z");
      // what `stop` waited on: the zombie's group still answers signal 0
      expect(() => process.kill(-pid, 0)).not.toThrow();
      mkdirSync(join(scratch, "state"));
      writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
      const started = Date.now();
      const stopped = await run("stop");
      expect(stopped.exitCode, stopped.err).toBe(0);
      expect(stopped.out).toContain(`stopped Ovis (pid ${pid})`);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
    } finally { parent.kill("SIGKILL"); }
  }, 30_000);
});

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

describe("pair relay offer", () => {
  async function pairWithRelay(phase: "online" | "off" | "missing" | "malformed" | "bad-offer") {
    const key = generateKeyPair();
    let offerRequests = 0;
    let validOfferUrl = "";
    const server = Bun.serve({
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
          // Construct via the shared encoder so this fixture exercises the production URL contract.
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
