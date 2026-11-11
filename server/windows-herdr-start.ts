import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";

export const WAITING_FOR_WINDOWS_LOGIN = "Waiting for Windows sign-in on this PC.";

/** Session-specific, separate from the bridge descriptor (which always means a usable bridge). */
export function windowsStartupStatus(registry: string, session?: string): string {
  return join(registry, `bridge${session ? `-${session}` : ""}.startup`);
}

const desktopLauncher = `
import { readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const path = fileURLToPath(new URL("./launch.json", import.meta.url));
const launch = JSON.parse(readFileSync(path, "utf8"));
rmSync(dirname(path), { recursive: true, force: true });
const log = openSync(launch.log, "a");
const child = Bun.spawn([launch.exe, ...launch.args], { cwd: launch.cwd, env: launch.env, stdin: "ignore", stdout: log, stderr: log, windowsHide: true });
closeSync(log);
process.exit(await child.exited);
`;

const interactiveScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$payloadText = [Console]::In.ReadToEnd()
$payload = $payloadText | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = Join-Path $payload.directory ('herdr-start-' + [Guid]::NewGuid().ToString('N'))
$taskName = 'Ovis-' + [IO.Path]::GetFileName($directory)
$registered = $null
$running = $null
try {
  # Windows file modes do not restrict readers: protect the directory before writing credentials.
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  foreach ($owner in @($sid, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  }
  [IO.Directory]::CreateDirectory($directory, $acl) | Out-Null
  $data = Join-Path $directory 'launch.json'
  [IO.File]::WriteAllText($data, $payloadText, (New-Object Text.UTF8Encoding $false))
  $launcher = Join-Path $directory 'start.ts'
  [IO.File]::WriteAllText($launcher, [string]$payload.launcher, (New-Object Text.UTF8Encoding $false))
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $folder = $scheduler.GetFolder('\')
  $task = $scheduler.NewTask(0)
  $task.Principal.UserId = $sid.Value
  $task.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN: no password or noninteractive fallback
  $task.Principal.RunLevel = 0 # ordinary user privileges
  $task.Settings.ExecutionTimeLimit = 'PT0S'
  $task.Settings.DisallowStartIfOnBatteries = $false
  $task.Settings.StopIfGoingOnBatteries = $false
  $action = $task.Actions.Create(0)
  # Only the private launcher's path enters the task definition, never its environment.
  $action.Path = $payload.bun
  $action.Arguments = '"' + $launcher + '"'
  $registered = $folder.RegisterTaskDefinition($taskName, $task, 2, $sid.Value, $null, 3)
  try { $running = $registered.Run($null) }
  catch {
    $exception = $_.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    if ($exception.HResult -eq -2147216608) { Write-Output 'waiting_login'; exit 0 } # SCHED_E_USER_NOT_LOGGED_ON
    throw
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([IO.Directory]::Exists($directory)) {
    if ($running.State -ne 2 -and $running.State -ne 4) {
      # A signed-out user's fresh task can stay Ready/never-run without Run throwing an error.
      if ($registered.State -eq 3 -and $registered.LastTaskResult -eq 267011) { Write-Output 'waiting_login'; exit 0 } # SCHED_S_TASK_HAS_NOT_RUN
      throw 'The interactive herdr launcher exited before reading its payload'
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      $running.Stop()
      throw 'The interactive herdr launcher did not read its payload within 30 seconds'
    }
    Start-Sleep -Milliseconds 100
  }
  Write-Output 'started'
} finally {
  # Unregistering a task leaves its running action (and herdr) alive.
  try { if ($null -ne $registered) { $folder.DeleteTask($taskName, 0) } }
  finally { if ([IO.Directory]::Exists($directory)) { Remove-Item -LiteralPath $directory -Recurse -Force } }
}
`;

/** A launch-only task escapes the bridge job without taking herdr into Session 0. */
export async function startInteractiveWindowsHerdr(exe: string, args: string[], log: string): Promise<"started" | "waiting_login"> {
  // PowerShell's .NET writes can reject the legacy registry junction as an untrusted mount point.
  const directory = realpathSync(dirname(log));
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(interactiveScript, "utf16le").toString("base64")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  child.stdin.write(JSON.stringify({ exe, args, log, directory, cwd: homedir(), env: process.env, bun: process.execPath, launcher: desktopLauncher }));
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`herdr could not be started in the Windows desktop session: ${stderr.trim()}`);
  if (stdout.trim() === "waiting_login") return "waiting_login";
  if (stdout.trim() !== "started") throw new Error("The interactive herdr launcher returned no startup result");
  return "started";
}

/** WMI keeps existing headless hosts independent of the bridge's kill-on-close job. */
export async function startHeadlessWindowsHerdr(exe: string, args: string[], log: string): Promise<void> {
  for (const value of [exe, ...args, log]) if (/["\r\n\0]/.test(value)) throw new Error(`Invalid characters in ${value}`);
  const line = `cmd.exe /d /c ""${exe}" ${args.join(" ")} >> "${log}" 2>&1"`;
  const environment = Object.entries(process.env).filter(([name, value]) => value !== undefined && !/[\r\n\0=]/.test(name) && !/[\r\n\0]/.test(value)).map(([name, value]) => `${name}=${value}`);
  const script = [
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    "[Console]::InputEncoding = [Text.Encoding]::UTF8; $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$payload.environment }",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $payload.line; CurrentDirectory = $payload.cwd; ProcessStartupInformation = $startup }",
    "exit $r.ReturnValue",
  ].join("\n");
  const ps = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdin: "pipe", stdout: "ignore", stderr: "pipe", windowsHide: true });
  ps.stdin.write(JSON.stringify({ line, environment, cwd: homedir() }));
  ps.stdin.end();
  const [code, stderr] = await Promise.all([ps.exited, new Response(ps.stderr).text()]);
  if (code !== 0) throw new Error(`herdr could not be started through WMI (${code}): ${stderr.trim()}`);
}
