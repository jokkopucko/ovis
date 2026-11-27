import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ovisName } from "../../../server/legacy-env.ts";
import type { Saved } from "../../../shared/desktop-command-listener.ts";
import { isFile, processStart, runProcess, windowsProcessQuery, withoutInherited } from "../../../shared/desktop-process.ts";

type Env = Record<string, string | undefined>;

export interface Layout {
  bun: string;
  hc: string;
  server: string;
  serverBinary: string;
}

export function layout(root: string, platform: NodeJS.Platform = process.platform): Layout {
  const exe = platform === "win32" ? ".exe" : "";
  return { bun: join(root, "bin", `bun${exe}`), hc: join(root, "bin", `herdr-core${exe}`), server: join(root, "server"), serverBinary: join(root, "server", `ovis-server${exe}`) };
}

/** hc's session for the app's own core, apart from the `default` one another hc client may run. */
export const HC_SESSION = "ovis";
export const coreSession = (env: Env): string => env["HC_SESSION"]?.trim() || HC_SESSION;

/** the lists an AppImage's AppRun puts its own folders in front of */
const APPIMAGE_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

/**
 * The environment hc runs in: the caller's, with the app's own core session unless one is named.
 * Electron's own settings are not passed on, nor an AppImage's: the core and its terminals outlive
 * the app, and its mount (APPDIR) goes away with it, so they would load its libraries meanwhile
 * and then point at a folder that is gone. Only this app's own mount (`execPath` inside it): an
 * AppImage's settings the app was merely started under stay, as for any other program.
 */
export function coreEnv(base: Env, execPath: string = process.execPath): Env {
  const env: Env = { ...base, HC_SESSION: coreSession(base) };
  // the app's own core: never one another client named with HC_SOCKET
  delete env["HC_SOCKET"];
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["ELECTRON_NO_ATTACH_CONSOLE"];
  const mount = base["APPIMAGE"] ? base["APPDIR"]?.replace(/\/+$/, "") : undefined;
  if (mount && execPath.startsWith(`${mount}/`)) {
    for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[name];
    for (const name of APPIMAGE_LISTS) {
      const value = env[name];
      if (value === undefined) continue;
      const kept = value.split(":").filter((entry) => entry.replace(/\/+$/, "") !== mount && !entry.startsWith(`${mount}/`));
      if (kept.some((entry) => entry !== "")) env[name] = kept.join(":");
      else delete env[name];
    }
  }
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
    // the app's own hc, not one the user named: one that does not answer leaves the server to find another, and say so
    OVIS_HC_BIN_BUNDLED: "1",
    OVIS_STATE_DIR: options.stateDir,
    HOST: "127.0.0.1",
    PORT: String(options.port),
    OVIS_DESKTOP_APP: "1",
  };
  const dropped = new Set(["HERDR_PLUGIN_ROOT", "HERDR_SOCKET", "OVIS_MANAGED", "OVIS_BOOT_ID", "OVIS_TOKEN"]);
  // the server would take a dropped setting back from its name before the rename (server/legacy-env.ts)
  for (const name of Object.keys(env)) if (dropped.has(name) || dropped.has(ovisName(name) ?? "")) delete env[name];
  return env;
}

export function openLog(path: string): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) renameSync(path, `${path}.1`);
  // opened now, not on a later tick: the file exists once this returns, and a folder removed meanwhile cannot fail the stream
  return createWriteStream(path, { fd: openSync(path, "a") });
}

export function tail(text: string, lines = 20): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * The hc the core runs from: a copy of the bundled one in the app's data folder, never the bundled
 * file itself. The core and its terminal holders outlive the app, and the bundled file does not
 * stay where it was (an AppImage's mount ends with the app; an update replaces the app). A newer
 * bundled hc replaces the copy the way hc's installer does (`hc update --from`), so the terminals
 * keep running. On Windows hc runs its terminals on the ConPTY beside it (`conpty\`): a first copy
 * takes that folder too, before the exe, and `hc update --from` brings the bundled one's along.
 */
export async function installCore(bundled: string, dir: string, env: Env, log: WriteStream, timeoutMs = 120_000): Promise<string> {
  const installed = join(dir, basename(bundled));
  if (isFile(installed) && sameBytes(bundled, installed)) return installed;
  if (!isFile(installed)) {
    mkdirSync(dir, { recursive: true });
    const conpty = join(dirname(bundled), "conpty");
    if (existsSync(conpty)) cpSync(conpty, join(dir, "conpty"), { recursive: true });
    copyFileSync(bundled, `${installed}.new`);
    chmodSync(`${installed}.new`, 0o755);
    renameSync(`${installed}.new`, installed);
    return installed;
  }
  // an hc newer than this app's (left by a newer app, before a rollback) is kept: hc refuses to go back
  const [have, want] = await Promise.all([hcVersion(installed, env), hcVersion(bundled, env)]);
  if (have !== null && want !== null && compareVersions(have, want) >= 0) return installed;
  const { code, output } = await runProcess(installed, ["update", "--from", bundled], env, log, timeoutMs);
  if (code !== 0) throw new Error(`herdr-core in ${dir} could not be updated to this app's (${code === null ? "timed out" : `exit code ${code}`})\n${tail(output)}`);
  return installed;
}

export async function hcVersion(hc: string, env: Env): Promise<number[] | null> {
  const { code, output } = await runProcess(hc, ["--version"], env, null, 10_000);
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
 * outlive the window, and the next start finds them. It starts in the home folder: a workspace
 * made without a folder opens in the core's, and the app's own (where the installer and the Start
 * menu start it on Windows) is replaced by an update and removed with the app. A home folder that
 * is not there leaves it in the app's: a missing folder would keep the core from starting at all.
 */
export async function startCore(hc: string, env: Env, log: WriteStream, timeoutMs = 30_000, home = homedir()): Promise<void> {
  const { code, output } = await runProcess(hc, ["server", "start"], env, log, timeoutMs, isDirectory(home) ? home : undefined);
  if (code !== 0) throw new Error(`herdr-core did not start (${code === null ? "timed out" : `exit code ${code}`})\n${tail(output)}`);
}

export interface RunningServer {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
}

const LISTENING = /^Ovis listening on (http:\/\/\S+)$/m;

export function startServer(layout: Layout, env: Env, log: WriteStream, timeoutMs = 60_000, onSpawn?: (child: ChildProcess) => void): Promise<RunningServer> {
  const [command, args] = withoutInherited(layout.serverBinary, ["serve"]);
  const child = spawn(command, args, { cwd: layout.server, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (child.pid !== undefined) onSpawn?.(child);
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
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

export function writeSaved(path: string, saved: Saved): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(saved));
  renameSync(`${path}.tmp`, path);
}

export interface ProcessProbe {
  command: (pid: number) => Promise<string | null>;
  started: (pid: number) => Promise<string | null>;
}

const SERVES = /^"? serve$/;

/**
 * Only the same process is ended: it still runs this app's Bun on its
 * server and started at the recorded time. A pid the system has since
 * given to another program, or to another server, is left alone.
 */
export async function endLeftover(saved: Saved["server"], probe?: ProcessProbe): Promise<boolean> {
  if (saved === null) return false;
  const line = await (probe?.command ?? processCommand)(saved.pid);
  // Windows writes the program's path in quotes when it has a space in it: `"C:\…\bun.exe" …`
  if (line === null) return false;
  const command = line.startsWith('"') ? line.slice(1) : line;
  // the binary's `serve`, or the server's source on Bun as an app from before the binary ran it
  if (!command.startsWith(saved.bun) || !(SERVES.test(command.slice(saved.bun.length)) || command.includes(join("server", "index.ts")))) return false;
  // without a start time it cannot be told from another process that got the pid since: left alone
  if (saved.started === null) return false;
  // Records made before the CLI used them stored ps's time in the desktop app's local time zone.
  const started = probe ? await probe.started(saved.pid) : await processStart(saved.pid, saved.ready === undefined ? "legacy" : "utc");
  if (started !== saved.started) return false;
  try { process.kill(saved.pid, "SIGTERM"); } catch { return false; }
  return true;
}

const WINDOWS = process.platform === "win32";
const psCommand = (pid: number): [string, string[]] => WINDOWS ? windowsProcessQuery(pid, "command") : ["ps", ["-o", "command=", "-p", String(pid)]];

export async function processCommand(pid: number): Promise<string | null> {
  const { code, output } = await runProcess(...psCommand(pid), process.env, null, WINDOWS ? 15_000 : 5_000);
  return code === 0 && output.trim() !== "" ? output.trim() : null;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
