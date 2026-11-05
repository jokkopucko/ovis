/**
 * The two programs the desktop app runs: herdr-core (`hc`), which owns the terminals, and the Ovis
 * server on the bundled Bun, which serves the window. Nothing here imports Electron, so the
 * tests run it under Bun.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { ovisName } from "../../../server/legacy-env.ts";

type Env = Record<string, string | undefined>;

/**
 * Chromium keeps files, sockets and pipes open without close-on-exec, so a program the app starts
 * would hold them, and the core (which outlives the app) for good. Started through this, bash
 * closes every descriptor above stderr, then becomes the program (same pid). Without /bin/bash
 * (NixOS) the program starts directly.
 */
const CLOSE_INHERITED = `for fd in $(ls /proc/$$/fd 2>/dev/null || ls /dev/fd); do if [ "$fd" -gt 2 ] 2>/dev/null; then eval "exec $fd>&-" 2>/dev/null; fi; done; exec "$@"`;

export function withoutInherited(command: string, args: string[], bash = "/bin/bash"): [string, string[]] {
  return isFile(bash) ? [bash, ["-c", CLOSE_INHERITED, "ovis", command, ...args]] : [command, args];
}

/** Where the staged programs sit: `resources/ovis` in a packaged app, `app/electron/stage` in development. */
export interface Layout {
  bun: string;
  hc: string;
  server: string;
}

export function layout(root: string): Layout {
  return { bun: join(root, "bin", "bun"), hc: join(root, "bin", "herdr-core"), server: join(root, "server") };
}

/** hc's session for the app's own core, apart from the `default` one another hc client may run. */
export const HC_SESSION = "ovis";

/**
 * The environment hc runs in: the caller's, with the app's own core session unless one is named.
 * Electron's own settings are not passed on.
 */
export function coreEnv(base: Env): Env {
  const env: Env = { ...base, HC_SESSION: base["HC_SESSION"]?.trim() || HC_SESSION };
  // the app's own core: never one another client named with HC_SOCKET
  delete env["HC_SOCKET"];
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["ELECTRON_NO_ATTACH_CONSOLE"];
  return env;
}

/**
 * The server's environment: herdr-core as its runtime, through the bundled hc, on loopback only,
 * with its state in the app's own folder. A herdr plugin's or supervisor's settings the app was
 * started under are dropped: this server is neither.
 */
export function serverEnv(base: Env, options: { hc: string; stateDir: string; port: number }): Env {
  const env: Env = {
    ...coreEnv(base),
    OVIS_RUNTIME: "herdr-core",
    OVIS_HC_BIN: options.hc,
    OVIS_STATE_DIR: options.stateDir,
    HOST: "127.0.0.1",
    PORT: String(options.port),
  };
  const dropped = new Set(["HERDR_PLUGIN_ROOT", "HERDR_SOCKET", "OVIS_MANAGED", "OVIS_BOOT_ID", "OVIS_TOKEN"]);
  // the server would take a dropped setting back from its name before the rename (server/legacy-env.ts)
  for (const name of Object.keys(env)) if (dropped.has(name) || dropped.has(ovisName(name) ?? "")) delete env[name];
  return env;
}

export function openLog(path: string): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) renameSync(path, `${path}.1`);
  return createWriteStream(path, { flags: "a" });
}

export function tail(text: string, lines = 20): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * The hc the core runs from: a copy of the bundled one in the app's data folder, never the bundled
 * file itself. The core and its terminal holders outlive the app, and the bundled file does not
 * stay where it was (an AppImage's mount ends with the app; an update replaces the app). A newer
 * bundled hc replaces the copy the way hc's installer does (`hc update --from`), so the terminals
 * keep running.
 */
export async function installCore(bundled: string, dir: string, env: Env, log: WriteStream, timeoutMs = 120_000): Promise<string> {
  const installed = join(dir, "herdr-core");
  if (isFile(installed) && sameBytes(bundled, installed)) return installed;
  if (!isFile(installed)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(bundled, `${installed}.new`);
    chmodSync(`${installed}.new`, 0o755);
    renameSync(`${installed}.new`, installed);
    return installed;
  }
  // an hc newer than this app's (left by a newer app, before a rollback) is kept: hc refuses to go back
  const [have, want] = await Promise.all([hcVersion(installed, env), hcVersion(bundled, env)]);
  if (have !== null && want !== null && compareVersions(have, want) >= 0) return installed;
  const { code, output } = await run(installed, ["update", "--from", bundled], env, log, timeoutMs);
  if (code !== 0) throw new Error(`herdr-core in ${dir} could not be updated to this app's (${code === null ? "timed out" : `exit code ${code}`})\n${tail(output)}`);
  return installed;
}

/** `[0, 1, 17]` for an hc that says `hc 0.1.17`, else null */
export async function hcVersion(hc: string, env: Env): Promise<number[] | null> {
  const { code, output } = await run(hc, ["--version"], env, null, 10_000);
  const match = code === 0 ? /^hc (\d+)\.(\d+)\.(\d+)/.exec(output.trim()) : null;
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function sameBytes(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return createHash("sha256").update(readFileSync(a)).digest("hex") === createHash("sha256").update(readFileSync(b)).digest("hex");
}

/**
 * Starts the app's core (`hc server start`, which returns once the core runs, or at once when it
 * already does). The core runs apart from the app, as hc runs it for every client: its terminals
 * outlive the window, and the next start finds them.
 */
export async function startCore(hc: string, env: Env, log: WriteStream, timeoutMs = 30_000): Promise<void> {
  const { code, output } = await run(hc, ["server", "start"], env, log, timeoutMs);
  if (code !== 0) throw new Error(`herdr-core did not start (${code === null ? "timed out" : `exit code ${code}`})\n${tail(output)}`);
}

export interface RunningServer {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
}

const LISTENING = /^Ovis listening on (http:\/\/\S+)$/m;

/**
 * Runs the Ovis server and resolves once it says where it listens. It fails when the server ends
 * first or says nothing within `timeoutMs`, with the end of its output.
 */
export function startServer(layout: Layout, env: Env, log: WriteStream, timeoutMs = 60_000, onSpawn?: (child: ChildProcess) => void): Promise<RunningServer> {
  const [command, args] = withoutInherited(layout.bun, [join(layout.server, "server", "index.ts")]);
  const child = spawn(command, args, { cwd: layout.server, env, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid !== undefined) onSpawn?.(child);
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  // the end of the output only: the line that says where it listens comes after whatever it printed first
  let output = "";
  const take = (chunk: Buffer) => {
    log.write(chunk);
    output = (output + chunk.toString("utf8")).slice(-64 * 1024);
  };
  child.stdout!.on("data", take);
  child.stderr!.on("data", take);
  return new Promise<RunningServer>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout!.off("data", listening);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve({ child, url: url!, exited });
    };
    const listening = () => {
      const match = LISTENING.exec(output);
      if (match) finish(null, match[1]!);
    };
    child.stdout!.on("data", listening);
    child.once("error", (error) => finish(new Error(`The Ovis server could not run: ${error.message}`)));
    void exited.then((code) => finish(new Error(`The Ovis server stopped (${code !== null ? `exit code ${code}` : `signal ${child.signalCode ?? "unknown"}`})\n${tail(output)}`)));
    const timer = setTimeout(() => finish(new Error(`The Ovis server did not start within ${Math.round(timeoutMs / 1000)} seconds\n${tail(output)}`)), timeoutMs);
  });
}

/** Asks the server to stop, and ends it when it has not after `graceMs` (its own shutdown takes about 2 seconds). */
export async function stopServer(server: Pick<RunningServer, "child" | "exited">, graceMs = 8_000): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = await Promise.race([
    server.exited.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), graceMs); }),
  ]);
  clearTimeout(timer);
  if (late) {
    server.child.kill("SIGKILL");
    await server.exited;
  }
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The port the server takes: the one it had last time while it is free, so the page keeps its
 * address (and the browser storage that goes with it), else a free one the system gives.
 */
export async function choosePort(saved: number | null): Promise<number> {
  if (saved !== null && Number.isInteger(saved) && saved > 1024 && saved < 65536 && await portFree(saved)) return saved;
  return freePort();
}

/** What the app keeps between runs, in `desktop.json` of its data folder. */
export interface Saved {
  port: number | null;
  /** the server it ran last, so a run after a crash can end one left behind; `started` is its start time (`ps -o lstart=`) */
  server: { pid: number; bun: string; started: string | null } | null;
}

export function readSaved(path: string): Saved {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Saved>;
    const port = typeof value.port === "number" ? value.port : null;
    const server = value.server && typeof value.server.pid === "number" && typeof value.server.bun === "string"
      ? { pid: value.server.pid, bun: value.server.bun, started: typeof value.server.started === "string" ? value.server.started : null }
      : null;
    return { port, server };
  } catch {
    return { port: null, server: null };
  }
}

export function writeSaved(path: string, saved: Saved): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(saved));
  renameSync(`${path}.tmp`, path);
}

export interface ProcessProbe {
  command: (pid: number) => Promise<string | null>;
  started: (pid: number) => Promise<string | null>;
}

/**
 * Ends the server an earlier run left behind (the app was killed before it could stop it), so two
 * never share one state folder. Only the same process is ended: it still runs this app's Bun on its
 * server and started at the recorded time. A pid the system has since
 * given to another program, or to another server, is left alone.
 */
export async function endLeftover(saved: Saved["server"], probe: ProcessProbe = { command: processCommand, started: processStart }): Promise<boolean> {
  if (saved === null) return false;
  const line = await probe.command(saved.pid);
  if (line === null || !line.startsWith(saved.bun) || !line.includes(join("server", "index.ts"))) return false;
  // without a start time it cannot be told from another process that got the pid since: left alone
  if (saved.started === null || await probe.started(saved.pid) !== saved.started) return false;
  try { process.kill(saved.pid, "SIGTERM"); } catch { return false; }
  return true;
}

export async function processCommand(pid: number): Promise<string | null> {
  const { code, output } = await run("ps", ["-o", "command=", "-p", String(pid)], process.env, null, 5_000);
  return code === 0 && output.trim() !== "" ? output.trim() : null;
}

/** processStart, waited for: a record written with it never lacks the start time */
export function processStartSync(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

export async function processStart(pid: number): Promise<string | null> {
  const { code, output } = await run("ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, LC_ALL: "C" }, null, 5_000);
  return code === 0 && output.trim() !== "" ? output.trim() : null;
}

async function run(command: string, args: string[], env: Env, log: WriteStream | null, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const [program, argv] = withoutInherited(command, args);
    const child = spawn(program, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    const take = (chunk: Buffer) => {
      log?.write(chunk);
      output += chunk.toString("utf8");
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
