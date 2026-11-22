import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { join as winJoin } from "node:path/win32";
import { guardPath } from "./owner-guard.ts";
import { readProcessBirth } from "./process-owner.ts";

const entryLines = readFileSync(new URL("./remote-entry.ts", import.meta.url), "utf8").split("\n");
const herdrConfigLine = entryLines.find((line) => line.startsWith("const herdrConfig ="));
const sessionLine = entryLines.find((line) => line.startsWith('const session = process.env["HERDR_REMOTE_SESSION"]'));
const socketLine = entryLines.find((line) => line.startsWith('process.env["HERDR_SOCKET"] ='));
if (!herdrConfigLine || !sessionLine || !socketLine) throw new Error("remote-entry socket setup was not found");

function windowsSocket(env: Record<string, string | undefined>): string {
  const evaluateSocket = new Function(
    "windows",
    "process",
    "join",
    "homedir",
    `${herdrConfigLine}\n${sessionLine}\n${socketLine}\nreturn process.env["HERDR_SOCKET"];`,
  );
  return String(evaluateSocket(true, { env }, winJoin, () => "C:\\Users\\u"));
}

describe("remote entry socket selection", () => {
  it("uses XDG_CONFIG_HOME before APPDATA on Windows", () => {
    // regression (fails on main): a set XDG_CONFIG_HOME owns herdr's Windows socket root
    expect(windowsSocket({ XDG_CONFIG_HOME: "C:\\Temp\\xdg", APPDATA: "C:\\Users\\u\\AppData\\Roaming", HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Temp\\xdg\\herdr\\sessions\\qa\\herdr.sock");
  });

  it("uses APPDATA when Windows XDG_CONFIG_HOME is absent", () => {
    expect(windowsSocket({ APPDATA: "C:\\Users\\u\\AppData\\Roaming", HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
  });

  it("uses the roaming profile when both Windows config variables are absent", () => {
    expect(windowsSocket({ HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
  });
});

/**
 * A socket's path as the entry reports it: its folder resolved, its own name kept. macOS refuses realpath on a
 * socket file itself (EOPNOTSUPP), and a last part that is a socket is no link.
 */
const realSocket = (socket: string) => join(realpathSync(dirname(socket)), basename(socket));

const earlierBirth = { platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : process.platform === "darwin" ? "Thu Jan 1 00:00:00 1970" : "1" };

describe("remote entry startup lock", () => {
  let home = "", descriptor = "", lock = "";
  const others: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "remote-entry-"));
    const socket = resolve(join(home, "config", "herdr", "herdr.sock"));
    descriptor = join(home, ".config/herdr-web-ui/bridges", createHash("sha256").update(socket).digest("hex") + ".json");
    lock = descriptor + ".lock";
    mkdirSync(join(home, ".config/herdr-web-ui/bridges"), { recursive: true });
  });
  afterEach(async () => {
    for (const other of others.splice(0)) { other.stdin.end(); await other.exited; }
    rmSync(home, { recursive: true, force: true });
  });
  function other() {
    const child = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
    others.push(child);
    return child;
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  function ownerLock(pid: number, birth: unknown) {
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(pid));
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, generation: "earlier-start", birth }));
  }
  async function start(preload?: string, choice: Record<string, string> = {}) {
    const entry = join(import.meta.dir, "remote-entry.ts");
    const proc = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), entry], {
      cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), OVIS_HERDR_BIN: join(home, "missing-herdr"), HERDR_REMOTE_SESSION: "", HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_START_NEW: "", HERDR_REMOTE_RESULT: "", HERDR_SOCKET: "", ...choice },
    });
    let serving = false;
    const deadline = setTimeout(() => { serving = true; proc.kill("SIGKILL"); }, 30_000);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).finally(() => clearTimeout(deadline));
    return { code, output: out + err, serving };
  }
  /** Signal 0 to `pid` is refused in the entry (EPERM), as another user's process refuses it. */
  function refusing(pid: number): string {
    const preload = join(home, "refuse-signal.ts");
    writeFileSync(preload, `const kill = process.kill.bind(process);\nprocess.kill = ((target, signal) => { if (target === ${pid}) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); return kill(target, signal); });\n`);
    return preload;
  }
  function fakeHerdr(socket = join(home, "config", "herdr", "herdr.sock")): { socket: string; stop(): void } {
    mkdirSync(dirname(socket), { recursive: true });
    const listener = Bun.listen<{ buffer: string }>({
      unix: socket,
      socket: {
        open(client) { client.data = { buffer: "" }; },
        data(client, chunk) {
          client.data.buffer += chunk.toString();
          for (let at = client.data.buffer.indexOf("\n"); at >= 0; at = client.data.buffer.indexOf("\n")) {
            const request = JSON.parse(client.data.buffer.slice(0, at)) as { id: string; method: string };
            client.data.buffer = client.data.buffer.slice(at + 1);
            if (request.method === "ping") client.write(`${JSON.stringify({ id: request.id, result: { version: "0.9.3", protocol: 22, capabilities: {} } })}\n`);
            else if (request.method !== "events.subscribe") client.write(`${JSON.stringify({ id: request.id, error: { code: "unsupported", message: "not in this test" } })}\n`);
          }
        },
      },
    });
    return { socket: realSocket(socket), stop: () => listener.stop(true) };
  }

  it.skipIf(process.platform === "win32")("refuses a second daemon and accepts only an explicit new-start choice", async () => {
    const socket = join(home, "config/herdr/sessions/work/herdr.sock");
    mkdirSync(dirname(socket), { recursive: true });
    const listener = Bun.listen({ unix: socket, socket: { data() {} } });
    const result = join(home, "startup.result");
    try {
      const refused = await start(undefined, { HERDR_REMOTE_RESULT: result });
      expect(refused.code).toBe(2);
      expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ code: "herdr_sessions_found", sessions: [{ socket_path: realSocket(socket), session: "work", label: "work" }] });
      expect(refused.output).not.toContain(join(home, "missing-herdr"));
      // Explicit consent alone reaches the attempted daemon spawn (a nonexistent test binary).
      const allowed = await start(undefined, { HERDR_REMOTE_START_NEW: "1" });
      expect(allowed.code).not.toBe(0);
      expect(allowed.output).toContain(join(home, "missing-herdr"));
    } finally { listener.stop(true); }
  }, 60_000);

  it.skipIf(process.platform === "win32")("never creates a daemon for a selected socket that has disappeared", async () => {
    const resultFile = join(home, "gone.result");
    const result = await start(undefined, { HERDR_REMOTE_SOCKET: join(home, "desktop/herdr/herdr.sock"), HERDR_REMOTE_RESULT: resultFile });
    expect(result.code).toBe(2);
    expect(result.output).toContain("chosen herdr session is no longer running");
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({ code: "herdr_session_gone", sessions: [] });
    expect(result.output).not.toContain(join(home, "missing-herdr"));
  }, 60_000);

  it.skipIf(process.platform === "win32")("starts herdr without extra consent when no sessions exist", async () => {
    const resultFile = join(home, "empty.result");
    const result = await start(undefined, { HERDR_REMOTE_RESULT: resultFile });
    expect(result.output).toContain(join(home, "missing-herdr"));
    expect(result.code).not.toBe(0);
    expect(existsSync(resultFile)).toBe(false);
  }, 60_000);

  it.skipIf(process.platform === "win32")("offers another live session when the selected socket has disappeared", async () => {
    const chosen = join(home, "config/herdr/sessions/gone/herdr.sock");
    const other = fakeHerdr(join(home, "config/herdr/sessions/other/herdr.sock"));
    const resultFile = join(home, "gone-with-other.result");
    try {
      const result = await start(undefined, { HERDR_REMOTE_SOCKET: chosen, HERDR_REMOTE_RESULT: resultFile });
      expect(result.code).toBe(2);
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({ code: "herdr_session_gone", sessions: [{ socket_path: other.socket, session: "other", label: "other" }] });
      expect(result.output).not.toContain(join(home, "missing-herdr"));
    } finally { other.stop(); }
  }, 60_000);

  it.skipIf(process.platform === "win32").each(["symlink", "parent symlink", "outside", "file"])("refuses a chosen %s before any bridge connection", async (kind) => {
    const actual = join(home, kind === "outside" ? "other" : "config/herdr", "herdr.sock");
    mkdirSync(dirname(actual), { recursive: true });
    let connections = 0;
    const listener = kind === "file" ? undefined : Bun.listen({ unix: actual, socket: { open(socket) { connections++; socket.end(); }, data() {} } });
    if (!listener) writeFileSync(actual, "not a socket");
    let selected = actual;
    if (kind === "symlink") { selected = join(home, "config/herdr/sessions/link/herdr.sock"); mkdirSync(dirname(selected), { recursive: true }); symlinkSync(actual, selected); }
    if (kind === "parent symlink") { symlinkSync(dirname(actual), join(home, "alias")); selected = join(home, "alias/herdr.sock"); }
    const resultFile = join(home, "refused.result");
    try {
      const result = await start(undefined, { HERDR_REMOTE_SOCKET: selected, HERDR_REMOTE_RESULT: resultFile });
      expect(result.code).toBe(2);
      expect(existsSync(resultFile)).toBe(true);
      expect(result.output).not.toContain(join(home, "missing-herdr"));
      // Only the explicit rejection may be reported; a ping to the untrusted target already violates the boundary.
      if (kind === "outside" || kind === "file") expect(connections).toBe(0);
    } finally { listener?.stop(true); }
  });

  it("removes stale startup results but keeps this start, recent results and other bridge files", async () => {
    const registry = dirname(descriptor);
    const files = ["startup-cancelled.result", "startup-current.result", "startup-recent.result", "bridge.log", "other.result"];
    const old = new Date(Date.now() - 20 * 60_000);
    for (const name of files) {
      const path = join(registry, name);
      writeFileSync(path, name);
      if (name !== "startup-recent.result") utimesSync(path, old, old);
    }
    const directory = join(registry, "startup-directory.result");
    mkdirSync(directory); utimesSync(directory, old, old);
    const bridge = other();
    writeFileSync(descriptor, JSON.stringify({ port: 1, token: "registered-secret", pid: bridge.pid, socket_path: "s", bridge_protocol: 1, bundle_version: "v" }));
    const run = await start(undefined, { HERDR_REMOTE_RESULT: join(registry, ".", "startup-current.result") });
    expect(run.code).toBe(0);
    expect(files.filter((name) => existsSync(join(registry, name)))).toEqual(["startup-current.result", "startup-recent.result", "bridge.log", "other.result"]);
    expect(readFileSync(join(registry, "startup-current.result"), "utf8")).toBe("startup-current.result");
    expect(existsSync(directory)).toBe(true);
    expect(existsSync(descriptor)).toBe(true);
  });

  it("reclaims a startup lock whose PID another process now holds", async () => {
    const reused = other();
    ownerLock(reused.pid, earlierBirth);
    const run = await start();
    expect(run.output).not.toContain("Another bridge is starting");
    expect(run.output).toContain(join(home, "missing-herdr"));
    expect(run.code).not.toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(guardPath(lock))).toBe(true);
    expect(alive(reused.pid)).toBe(true);
  }, 60_000);

  it("waits for a live starter", async () => {
    const starter = other();
    const reading = readProcessBirth(starter.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${starter.pid}`);
    ownerLock(starter.pid, reading.birth);
    const owner = readFileSync(join(lock, "owner.json"), "utf8");
    const run = await start();
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`Another bridge is starting; retry shortly (lock ${lock}, owner pid ${starter.pid} generation earlier-start)`);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(owner);
  }, 60_000);

  it("keeps a live starter's lock and a live bridge's descriptor whose recorded birth is malformed", async () => {
    const starter = other(), bridge = other();
    ownerLock(starter.pid, { platform: process.platform, value: "" });
    const owner = readFileSync(join(lock, "owner.json"), "utf8");
    const refused = await start();
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain(`Another bridge is starting; retry shortly (lock ${lock}, owner pid ${starter.pid})`);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(owner);
    rmSync(lock, { recursive: true });
    const text = JSON.stringify({ port: 1, token: "registered-secret", pid: bridge.pid, generation: "g", birth: { platform: process.platform }, socket_path: "s", bridge_protocol: 1, bundle_version: "v" });
    writeFileSync(descriptor, text);
    const run = await start();
    expect(run.code).toBe(0);
    expect(run.output).not.toContain(join(home, "missing-herdr"));
    expect(readFileSync(descriptor, "utf8")).toBe(text);
    expect(existsSync(lock)).toBe(false);
    expect([alive(starter.pid), alive(bridge.pid)]).toEqual([true, true]);
  }, 60_000);

  it("fails closed when the guard is unavailable", async () => {
    const reused = other();
    ownerLock(reused.pid, earlierBirth);
    const owner = readFileSync(join(lock, "owner.json"), "utf8");
    const preload = join(home, "no-guard.ts");
    writeFileSync(preload, `import { guardLibrary } from ${JSON.stringify(join(import.meta.dir, "owner-guard.ts"))};\nguardLibrary.path = ${JSON.stringify(join(home, "missing-libc.so.6"))};\n`);
    const run = await start(preload);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`Another bridge is starting; retry shortly (lock ${lock}, owner pid ${reused.pid} generation earlier-start; the file lock could not be loaded`);
    expect(run.output).not.toContain(join(home, "missing-herdr"));
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(owner);
    expect(alive(reused.pid)).toBe(true);
  }, 60_000);

  it("starts over a registered bridge whose PID a process it may not signal now holds", async () => {
    const reused = other();
    const preload = refusing(reused.pid);
    // an older version's descriptor has no birth: outside Windows the refusal alone proves it someone else's
    for (const fields of [{ birth: earlierBirth }, ...(process.platform === "win32" ? [] : [{}])]) {
      writeFileSync(descriptor, JSON.stringify({ port: 1, token: "registered-secret", pid: reused.pid, generation: "g", ...fields, socket_path: "s", bridge_protocol: 1, bundle_version: "v" }));
      const run = await start(preload);
      expect(run.output).toContain(join(home, "missing-herdr"));
      expect(run.code).not.toBe(0);
    }
    expect(alive(reused.pid)).toBe(true);
  }, 60_000);

  it.skipIf(process.platform === "win32")("stops a bridge it could not register", async () => {
    const herdr = fakeHerdr();
    try {
      const registered = join(home, ".config/herdr-web-ui/bridges", createHash("sha256").update(herdr.socket).digest("hex") + ".json");
      // a guard this start cannot open stands for one left by another account
      mkdirSync(guardPath(registered));
      const run = await start();
      expect(run.serving).toBe(false);
      expect(run.output).toContain(`This bridge was not registered (descriptor ${registered})`);
      expect(run.output).toContain(`This bridge stopped because it was not registered (descriptor ${registered})`);
      expect(run.code).not.toBe(0);
      expect(existsSync(registered)).toBe(false);
      expect(existsSync(registered + ".lock")).toBe(false);
    } finally { herdr.stop(); }
  }, 60_000);

  it("starts over a registered bridge whose PID another process now holds, and leaves a live one", async () => {
    const reused = other(), bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    const registered = (pid: number, birth: { platform: string; value: string }) =>
      writeFileSync(descriptor, JSON.stringify({ port: 1, token: "registered-secret", pid, generation: "g", birth, socket_path: "s", bridge_protocol: 1, bundle_version: "v" }));
    registered(reused.pid, earlierBirth);
    expect((await start()).output).toContain(join(home, "missing-herdr"));
    registered(bridge.pid, reading.birth);
    const run = await start();
    expect(run.code).toBe(0);
    expect(run.output).not.toContain(join(home, "missing-herdr"));
    expect(existsSync(lock)).toBe(false);
  }, 60_000);
});
