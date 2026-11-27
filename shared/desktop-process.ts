import { execFileSync, spawn } from "node:child_process";
import { statSync, type WriteStream } from "node:fs";

/**
 * Chromium keeps files, sockets and pipes open without close-on-exec, so a program the app starts
 * would hold them, and the core (which outlives the app) for good. Started through this, bash
 * closes every descriptor above stderr, then becomes the program (same pid). Without /bin/bash
 * (NixOS) the program starts directly. Windows hands a child only the handles marked inheritable,
 * and has no /bin/bash: there the program always starts directly.
 */
const CLOSE_INHERITED = `for fd in $(ls /proc/$$/fd 2>/dev/null || ls /dev/fd); do if [ "$fd" -gt 2 ] 2>/dev/null; then eval "exec $fd>&-" 2>/dev/null; fi; done; exec "$@"`;

export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function withoutInherited(command: string, args: string[], bash = "/bin/bash", platform: NodeJS.Platform = process.platform): [string, string[]] {
  return platform !== "win32" && isFile(bash) ? [bash, ["-c", CLOSE_INHERITED, "ovis", command, ...args]] : [command, args];
}

/**
 * Windows has no ps: a process's command line and start time come from CIM (Win32_Process), its
 * start as a UTC timestamp, which stays the same for one process and differs for a pid given out again.
 */
export function windowsProcessQuery(pid: number, field: "command" | "started"): [string, string[]] {
  const value = field === "command" ? "$p.CommandLine" : "$p.CreationDate.ToUniversalTime().ToString('o')";
  return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}'; if ($p) { ${value} }`]];
}

const WINDOWS = process.platform === "win32";
const psStart = (pid: number): [string, string[]] => WINDOWS ? windowsProcessQuery(pid, "started") : ["ps", ["-o", "lstart=", "-p", String(pid)]];

export function processStartSync(pid: number): string | null {
  try {
    const [command, args] = psStart(pid);
    const output = execFileSync(command, args, { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", timeout: WINDOWS ? 15_000 : 5_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

export async function processStart(pid: number, zone: "utc" | "legacy" = "utc"): Promise<string | null> {
  const { code, output } = await runProcess(...psStart(pid), { ...process.env, LC_ALL: "C", ...(zone === "utc" ? { TZ: "UTC" } : {}) }, null, WINDOWS ? 15_000 : 5_000);
  return code === 0 && output.trim() !== "" ? output.trim() : null;
}

export async function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, log: WriteStream | null, timeoutMs: number, cwd?: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const [program, argv] = withoutInherited(command, args);
    const child = spawn(program, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const take = (chunk: Buffer) => {
      log?.write(chunk);
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
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
