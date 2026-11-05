// The bundle is launched only through SSH. Keep it alive after the tunnel closes;
// herdr owns the terminal processes and no disconnect should terminate their work.
import "./adopt-legacy-env.ts";
import { createServer } from "./index.ts";
import { bridgeIdentity, descriptorLive, descriptorPath, registerBridge } from "./bridge.ts";
import { acquireOwnerDirectory } from "./owner-guard.ts";
import { parseProcessLine, refusedSocket, staleMarker } from "./herdr-marker.ts";
import { startHeadlessWindowsHerdr, startInteractiveWindowsHerdr, windowsStartupStatus } from "./windows-herdr-start.ts";
import { ShellAgentLocator } from "./shell-agent.ts";
import { AgentDetector, catalogLocator, defaultLoginProbe } from "./agent-catalog-detect.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

process.env["OVIS_REMOTE"] = "1";
const windows = process.platform === "win32";
// the transcript readers find agent stores under $HOME, which Windows does not set
if (windows && !process.env["HOME"]) process.env["HOME"] = homedir();
const bundle = join(import.meta.dir, "..");
process.env["PATH"] = `${join(bundle, "bin")}${delimiter}${process.env["PATH"] ?? "/usr/bin:/bin"}`;
const session = process.env["HERDR_REMOTE_SESSION"];
// herdr puts its sockets under XDG_CONFIG_HOME when it is set (GitHub's Linux runners and some
// desktops set it), so the bridge must look where the daemon it starts will listen; on
// Windows they live under XDG_CONFIG_HOME when set, then %APPDATA%\herdr (`herdr status server`)
const herdrConfig = windows ? join(process.env["XDG_CONFIG_HOME"] || process.env["APPDATA"] || join(homedir(), "AppData", "Roaming"), "herdr") : join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr");
process.env["HERDR_SOCKET"] = session ? join(herdrConfig, "sessions", session, "herdr.sock") : join(herdrConfig, "herdr.sock");
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
if (windows) rmSync(windowsStartupStatus(dirname(descriptor), session), { force: true });
// the lock records its owner's birth: a PID that now belongs to another process does not block this start
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
