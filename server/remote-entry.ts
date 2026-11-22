import "./adopt-legacy-env.ts";
import { createServer } from "./index.ts";
import { ROOT } from "./entries.ts";
import { bridgeIdentity, descriptorLive, descriptorPath, registerBridge } from "./bridge.ts";
import { acquireOwnerDirectory } from "./owner-guard.ts";
import { parseProcessLine, refusedSocket, staleMarker } from "./herdr-marker.ts";
import { startHeadlessWindowsHerdr, startInteractiveWindowsHerdr, windowsStartupStatus } from "./windows-herdr-start.ts";
import { ShellAgentLocator } from "./shell-agent.ts";
import { AgentDetector, catalogLocator, defaultLoginProbe } from "./agent-catalog-detect.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { chosenHerdrSocketStatus, discoverHerdrSessions, validHerdrSocket } from "./herdr-discovery.ts";

// What setup asks the installed runtime before a bridge runs (server/remote-host.ts): the bundle carries no sources a
// `bun -e` could import, so the answers come from this entry, and nothing below runs for them
const [request, socketArgument, ...extra] = process.argv.slice(2);
const REMOTE_USAGE = "usage: ovis-server remote [--discover | --socket-status <herdr socket>]\n  with no argument: the bridge for the herdr session HERDR_REMOTE_SESSION names, started over SSH";
if (request === "--help") {
  console.log(REMOTE_USAGE);
  process.exit(0);
}
if (request === "--discover" && socketArgument === undefined) {
  console.log(JSON.stringify(await discoverHerdrSessions()));
  process.exit(0);
}
if (request === "--socket-status" && socketArgument !== undefined && extra.length === 0) {
  console.log(await chosenHerdrSocketStatus(socketArgument));
  process.exit(0);
}
if (request !== undefined) {
  console.error(REMOTE_USAGE);
  process.exit(2);
}

process.env["OVIS_REMOTE"] = "1";
const windows = process.platform === "win32";
// the transcript readers find agent stores under $HOME, which Windows does not set
if (windows && !process.env["HOME"]) process.env["HOME"] = homedir();
const bundle = ROOT;
process.env["PATH"] = `${join(bundle, "bin")}${delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`;
const session = process.env["HERDR_REMOTE_SESSION"];
// herdr puts its sockets under XDG_CONFIG_HOME when it is set (GitHub's Linux runners and some
// desktops set it), so the bridge must look where the daemon it starts will listen; on
// Windows they live under XDG_CONFIG_HOME when set, then %APPDATA%\herdr (`herdr status server`)
const herdrConfig = windows ? join(process.env["XDG_CONFIG_HOME"] || process.env["APPDATA"] || join(homedir(), "AppData", "Roaming"), "herdr") : join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr");
process.env["HERDR_SOCKET"] = session ? join(herdrConfig, "sessions", session, "herdr.sock") : join(herdrConfig, "herdr.sock");
const chosenSocket = windows ? undefined : process.env["HERDR_REMOTE_SOCKET"];
if (chosenSocket) {
  if (!validHerdrSocket(chosenSocket)) throw new Error("The herdr socket must be an absolute path ending in /herdr.sock");
  process.env["HERDR_SOCKET"] = chosenSocket;
}
function staleWindowsMarker(path: string): boolean {
  return staleMarker(readFileSync(path, "utf8"), (pid) => {
    try {
      const probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName + '|' + ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`], { stdin: "ignore", stderr: "ignore" });
      if (probe.exitCode === 0) return parseProcessLine(probe.stdout.toString());
    } catch { /* no PowerShell: the pid alone has to do */ }
    try { process.kill(pid, 0); return { name: "herdr", startedMs: null }; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? null : { name: "herdr", startedMs: null }; }
  });
}

const descriptor = descriptorPath();
mkdirSync(dirname(descriptor), { recursive: true, mode: 0o700 });
async function startBridge(): Promise<void> {
const resultDirectory = dirname(descriptor);
const currentResult = process.env["HERDR_REMOTE_RESULT"];
try {
  const cutoff = Date.now() - 5 * 60_000;
  const uid = process.getuid?.();
  for (const name of readdirSync(resultDirectory)) {
    if (!/^startup-[^/]+\.result$/.test(name)) continue;
    const path = join(resultDirectory, name);
    if (currentResult && path === resolve(currentResult)) continue;
    try {
      const file = lstatSync(path);
      if (file.isFile() && (uid === undefined || file.uid === uid) && file.mtimeMs < cutoff) rmSync(path);
    } catch {}
  }
} catch {}
const report = (code: "herdr_sessions_found" | "herdr_session_gone", sessions: Awaited<ReturnType<typeof discoverHerdrSessions>>, refusal?: string) => {
  const result = JSON.stringify({ code, sessions });
  const resultPath = process.env["HERDR_REMOTE_RESULT"];
  if (resultPath) { writeFileSync(resultPath + ".tmp", result, { mode: 0o600 }); renameSync(resultPath + ".tmp", resultPath); }
  console.error(refusal ?? (code === "herdr_session_gone" ? "The chosen herdr session is no longer running or answering. Choose a running session on this PC again." : "A herdr session is already running on this PC. Choose it or start a new one."));
  process.exitCode = 2;
};
// Validate before even pinging it or accepting an existing bridge descriptor for it.
if (chosenSocket) {
  const status = await chosenHerdrSocketStatus(chosenSocket);
  if (status === "refused") return report("herdr_session_gone", [], "The chosen herdr socket cannot be used safely by this account. Choose a session on this PC again.");
  if (status === "gone") return report("herdr_session_gone", (await discoverHerdrSessions()).filter((found) => found.socket_path !== chosenSocket));
}
if (windows) rmSync(windowsStartupStatus(dirname(descriptor), session), { force: true });
const lock = acquireOwnerDirectory(descriptor + ".lock", { running: "Another bridge is starting; retry shortly", starting: "Another bridge is starting; retry shortly" });
try {
  let existing = false;
  try { existing = descriptorLive(JSON.parse(readFileSync(descriptor, "utf8"))); } catch {}
  if (!existing) {
  try { await bridgeIdentity(); } catch (error) {
    // A socket that exists but cannot answer is an operator problem, not permission
    // to replace the daemon. Only absent sockets permit starting a new server.
    // on Windows the socket is a marker file `pid:start` that a killed herdr leaves behind;
    // its pid says whether a daemon is really there. Elsewhere a killed herdr (or a reboot)
    // leaves the socket file, and a refused connection says nobody listens on it
    const socket = process.env["HERDR_SOCKET"]!;
    if (existsSync(socket) && !(windows ? staleWindowsMarker(socket) : await refusedSocket(socket))) throw error;
    // A selected socket is an existing daemon's identity, never permission to create its replacement: the owner
    // chooses again, among the sessions running now
    if (chosenSocket) return report("herdr_session_gone", (await discoverHerdrSessions()).filter((found) => found.socket_path !== chosenSocket));
    if (!windows && process.env["HERDR_REMOTE_START_NEW"] !== "1") {
      const sessions = await discoverHerdrSessions();
      if (sessions.length) return report("herdr_sessions_found", sessions);
    }
    // a Windows bundle carries no herdr: its installer is herdr's own, and setup ran it
    const herdr = process.env["OVIS_HERDR_BIN"] || join(bundle, "bin/herdr");
    if (windows && !existsSync(herdr)) throw new Error(`herdr is not installed at ${herdr}; install it with herdr.dev/install.cmd`);
    const args = session ? ["--session", session, "server"] : ["server"];
    // one log per session on Windows: cmd holds the file a running daemon's output goes to
    const log = join(dirname(descriptor), windows && session ? `herdr-${session}.log` : "herdr.log");
    if (windows) {
      const registry = dirname(descriptor);
      const status = windowsStartupStatus(registry, session);
      if (process.env["OVIS_WINDOWS_HEADLESS_START"] !== "1") {
        try {
          if (await startInteractiveWindowsHerdr(herdr, args, log) === "waiting_login") {
            writeFileSync(status, "waiting_login");
            return;
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          writeFileSync(status, `interactive_failed: ${error.message}`);
          return;
        }
      } else await startHeadlessWindowsHerdr(herdr, args, log);
    }
    else Bun.spawn([herdr, ...args], { stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log) }).unref();
    let ready = false;
    // a cold first start (fresh HOME, slow disk or CI runner) can take well over ten seconds
    for (let i = 0; i < 300; i++) { try { await bridgeIdentity(); ready = true; break; } catch { await Bun.sleep(100); } }
    if (!ready) throw new Error("herdr did not start; inspect ~/.config/herdr-web-ui/bridges/herdr.log");
  }
  const info = await bridgeIdentity();
  if (info.herdr.protocol < 22) throw new Error("herdr 0.9+ is required; update it explicitly before connecting");
  const token = randomBytes(32).toString("hex");
  // a folder a machine profile marked is its own: createServer refuses it (server/profile-marker.ts)
  // started over SSH with a bare PATH: omo and gjc are often only on the login shell's
  const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, bridgeOnly: true, stateDir: descriptor + ".state", shellAgents: new ShellAgentLocator(), agentDetector: new AgentDetector({ locate: catalogLocator({ probe: defaultLoginProbe() }) }) });
  const registration = registerBridge(server.port, token);
  if (!registration.registered) {
    // the app finds a bridge only through its descriptor: an unregistered one serves nobody, and
    // the app would start one more on every retry, so this one stops
    server.stop();
    throw new Error(`This bridge stopped because it was not registered (descriptor ${descriptor})`);
  }
  server.warmAgentCatalog();
  const close = () => { registration.close(); server.stop(); setTimeout(() => process.exit(0), 2000); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  }
} finally { lock.release(); }
}
await startBridge();
