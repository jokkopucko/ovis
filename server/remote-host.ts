/**
 * What setup does on a PC, in that PC's own shell. A Linux or macOS host runs sh; a
 * Windows host runs PowerShell (OpenSSH there defaults to cmd, which cannot even find
 * `sh`). Both keep the same contract: the bridge registry under ~/.config/herdr-web-ui,
 * one runtime directory per bundle version, and a descriptor per herdr socket.
 *
 * Windows differs in three places that are easy to get wrong:
 * - herdr's socket is a marker file plus a named pipe of the same path (herdr/client.ts).
 * - A process started inside the SSH session dies with it. The bridge is created through
 *   WMI (Win32_Process.Create), whose parent is the WMI host, so the bridge survives logout.
 * - An administrator's authorized keys live in %ProgramData%\ssh\administrators_authorized_keys
 *   with a fixed ACL; everyone else's in ~\.ssh\authorized_keys.
 */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { win32 } from "node:path";
import { REMOTE_BUNDLE_VERSION, type FoundHerdrSession, type SshTarget } from "../shared/machines.ts";
import { parseFoundHerdrSessions, validHerdrSocket } from "./herdr-discovery.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { shellQuote } from "./machine-security.ts";
import { bundleFile, type InstallStage } from "./remote-bundle.ts";
import type { SshConnection } from "./ssh.ts";
import { psQuote } from "./powershell.ts";
import { WAITING_FOR_WINDOWS_LOGIN } from "./windows-herdr-start.ts";

export const REMOTE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
export const BUNDLE_DIR = `.local/share/herdr-web-ui/remote-v${REMOTE_BUNDLE_VERSION}`;
/** the Windows runtime directory, under %LOCALAPPDATA%; `$base` in the scripts below */
export const WINDOWS_BUNDLE_BASE = "$env:LOCALAPPDATA\\herdr-web-ui";
export const UNSUPPORTED_HOST = "Only Linux, macOS (x64 or arm64) and Windows (x64) PCs are supported.";
export const HERDR_INSTALL_CMD = "https://herdr.dev/install.cmd";

/** the upload is cut off after this long on the PC, as a dead SSH link may never deliver EOF */
export const INSTALL_UPLOAD_TIMEOUT_S = 25 * 60;
const INSTALL_EXTRACT_TIMEOUT_MS = 10 * 60_000;
// Allow time for staging, progress probes and cleanup beyond the bounded upload and extraction.
const INSTALL_LOCK_MAX_AGE_MINUTES = Math.ceil((INSTALL_UPLOAD_TIMEOUT_S * 1000 + INSTALL_EXTRACT_TIMEOUT_MS) / 60_000) + 5;
/**
 * Takes `$base/install.lock` (a directory holding the owner's PID). A lock whose owner is
 * gone, or that outlived the longest possible install (the local SSH timeout is 30 minutes),
 * was left by an install that never reached its trap; it is reclaimed rather than blocking
 * every retry until someone deletes it by hand. Expects `$base`; sets `$lock`.
 *
 * Reclaiming happens under `install.lock.reclaim`, a second mkdir mutex, with the owner and
 * age read again inside it: two installers that both judged the lock stale cannot then
 * delete each other's fresh lock. A mutex left by a reclaimer that died is dropped after two
 * minutes, and that run reports "in progress"; the retry takes over.
 * The lock directory exists for an instant before its PID file is written. In that window
 * other installers see it as in progress, and if its creator dies there, only the age check
 * can reclaim it.
 */
export const POSIX_INSTALL_LOCK = `lock="$base/install.lock"; if ! mkdir "$lock" 2>/dev/null; then mkdir "$lock.reclaim" 2>/dev/null || { test -z "$(find "$lock.reclaim" -maxdepth 0 -mmin +2 2>/dev/null)" || rmdir "$lock.reclaim" 2>/dev/null; printf 'Another installation is in progress; retry shortly\\n' >&2; exit 1; }; owner=$(cat "$lock/pid" 2>/dev/null || true); if { test -n "$owner" && ! kill -0 "$owner" 2>/dev/null; } || test -n "$(find "$lock" -maxdepth 0 -mmin +${INSTALL_LOCK_MAX_AGE_MINUTES} 2>/dev/null)"; then rm -rf "$lock"; mkdir "$lock" 2>/dev/null || { rmdir "$lock.reclaim"; printf 'Another installation is in progress; retry shortly\\n' >&2; exit 1; }; printf '%s' "$$" > "$lock/pid"; rmdir "$lock.reclaim"; else rmdir "$lock.reclaim"; printf 'Another installation is in progress; retry shortly\\n' >&2; exit 1; fi; fi; printf '%s' "$$" > "$lock/pid";`;
/** the exit trap's release: only a lock this shell still owns, never a successor's */
export const POSIX_INSTALL_RELEASE = `test "$(cat "$lock/pid" 2>/dev/null)" != "$$" || rm -rf "$lock"`;

/**
 * Windows' mirror of {@link POSIX_INSTALL_LOCK}: the same directory mutex around the upload.
 *
 * The owner cannot be probed the way a POSIX shell's can. The PowerShell that stages the upload
 * exits before the upload runs, so a PID written here would look dead while the install is alive,
 * and every peer would reclaim a lock that is still in use. The lock therefore holds a unique
 * `$owner` attempt beneath this server and target's stable `$reclaim` prefix. This process admits
 * only one live attempt for that prefix, so a matching lock is its stopped predecessor; cleanup
 * still compares the whole unique owner and can never remove a successor's lock. A peer's lock is
 * reclaimed only after the bounded upload and extraction, plus a margin for the other SSH calls.
 *
 * Reclaiming happens under `install.lock.reclaim`, a second mutex, with the owner and age read
 * again inside it: two installers that both judged the lock stale cannot then delete each other's
 * fresh lock. A mutex left by a reclaimer that died is dropped after two minutes, and that run
 * reports "in progress"; the retry takes over. Paths go through `Join-Path` so the scripts also run
 * under `pwsh` off Windows, where the tests exercise them.
 * Expects `$base`, `$reclaim` and `$owner`; sets `$lock`.
 */
export const WINDOWS_INSTALL_LOCK = `$lock = Join-Path $base 'install.lock'; $mutex = "$lock.reclaim"; $created = $false; try { New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null; $created = $true } catch {}; if (-not $created) { try { New-Item -ItemType Directory $mutex -ErrorAction Stop | Out-Null } catch { $stale = Get-Item -LiteralPath $mutex -ErrorAction SilentlyContinue; if ($stale -and ((Get-Date).ToUniversalTime() - $stale.LastWriteTimeUtc).TotalMinutes -gt 2) { Remove-Item -Recurse -Force $mutex -ErrorAction SilentlyContinue }; throw 'Another installation is in progress; retry shortly' }; try { if (Test-Path -LiteralPath $lock) { $held = ([string](Get-Content -LiteralPath (Join-Path $lock 'owner') -Raw -ErrorAction SilentlyContinue)).Trim(); $age = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $lock).LastWriteTimeUtc).TotalMinutes; if ($held.StartsWith($reclaim + ':') -or ($age -gt ${INSTALL_LOCK_MAX_AGE_MINUTES})) { Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue } }; New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null; $created = $true } catch { throw 'Another installation is in progress; retry shortly' } finally { Remove-Item -Recurse -Force $mutex -ErrorAction SilentlyContinue } }; if (-not $created) { throw 'Another installation is in progress; retry shortly' }; Set-Content -LiteralPath (Join-Path $lock 'owner') -Value $owner -NoNewline -Encoding ascii`;

/** the Windows release: only a lock this server still owns, never a successor's */
export const WINDOWS_INSTALL_RELEASE = `$target = Join-Path $base 'install.lock'; if ((Test-Path -LiteralPath $target) -and (([string](Get-Content -LiteralPath (Join-Path $target 'owner') -Raw -ErrorAction SilentlyContinue)).Trim() -eq $owner)) { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }`;

export interface HostInspection {
  platform: "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";
  home: string;
  /** an installed herdr, empty when the bundle's (or, on Windows, herdr's installer) is needed */
  herdrPath: string;
  /** the socket the bridge will register, exactly as its own bridgeIdentity() spells it */
  expectedSocket: string;
  /** the socket of the session itself, spelled the same way: tells a chosen socket that is no choice (POSIX only) */
  defaultSocket?: string;
  bundleReady: boolean;
  bundleOlder: boolean;
  descriptors: BridgeDescriptor[];
  /** this bundle version's runtime directory and the bridge registry, as absolute paths on the PC */
  runtimeDir: string;
  registryDir: string;
  /** A unique POSIX startup attempt's result, never shared with an earlier attempt. */
  startupResult?: string;
}
export interface StartOptions { session?: string; herdrPath: string; inspection: HostInspection; headless?: boolean; herdr_socket?: string; start_new_herdr?: boolean }
/**
 * The Windows lock's stable reclaim prefix. It is ASCII-safe even when the state directory,
 * destination or account is not. The state directory and target outlive a restart (a PID does
 * not), so this server can reclaim its stopped predecessor while another target or server waits.
 */
export function installLockOwner(stateDir: string, target: Pick<SshTarget, "destination" | "port"> = { destination: "" }): string {
  return createHash("sha256").update(`${hostname()}\0${stateDir}\0${target.destination}\0${target.port ?? ""}`).digest("hex");
}

const activeWindowsInstalls = new Set<string>();
const INSTALL_BUSY = "Another installation is in progress; retry shortly";

/** One unique attempt per stable server/target owner; a stopped attempt remains reclaimable. */
export async function withWindowsInstallAttempt<T>(reclaim: string, run: (owner: string) => Promise<T>): Promise<T> {
  if (activeWindowsInstalls.has(reclaim)) throw new Error(INSTALL_BUSY);
  activeWindowsInstalls.add(reclaim);
  try { return await run(`${reclaim}:${randomUUID()}`); }
  finally { activeWindowsInstalls.delete(reclaim); }
}

export interface InstallOptions {
  cacheDir?: string;
  /** who holds the Windows install lock; {@link installLockOwner} unless a caller says otherwise */
  owner?: string;
  onProgress?(stage: InstallStage, done: number, total: number | null): void;
}

export interface RemoteHost {
  readonly kind: "posix" | "windows";
  /** the words the approval list uses for the runtime bundle */
  readonly bundleDescription: string;
  readonly logHint: string;
  inspect(ssh: SshConnection, session?: string, socket?: string): Promise<HostInspection>;
  herdrVersion(ssh: SshConnection, herdrPath: string): Promise<string>;
  alive(ssh: SshConnection, pid: number): Promise<boolean>;
  authorizeKey(ssh: SshConnection, keyLine: string): Promise<void>;
  installBundle(ssh: SshConnection, platform: string, signal: AbortSignal, options?: InstallOptions): Promise<void>;
  /** Windows only: herdr's own installer, when the host has none (a bundle carries none there) */
  installHerdr?(ssh: SshConnection): Promise<string>;
  stop(ssh: SshConnection, pid: number): Promise<void>;
  start(ssh: SshConnection, options: StartOptions): Promise<void>;
  /** A cold start needing desktop sign-in or consent after an interactive-launch failure. */
  startupNotice?(ssh: SshConnection, session?: string): Promise<string | null>;
  /** what the bridge asked the owner to choose: herdr sessions running there, or (`gone`) that the chosen one stopped */
  foundSessions?(ssh: SshConnection, inspection: HostInspection): Promise<{ gone: boolean; sessions: FoundHerdrSession[] } | null>;
  /** a chosen socket checked on the PC by the rule its bridge applies (server/herdr-discovery.ts); null when it cannot be */
  chosenSocketStatus?(ssh: SshConnection, inspection: HostInspection, socket: string): Promise<"usable" | "gone" | "refused" | null>;
  /** Read-only discovery, including when the chosen Ovis server is stopped. */
  discoverSessions?(ssh: SshConnection, inspection: HostInspection): Promise<FoundHerdrSession[]>;
  descriptors(ssh: SshConnection): Promise<BridgeDescriptor[]>;
}

/** the most a PC's herdr discovery answer (or its error) may send */
const DISCOVERY_OUTPUT_BYTES = 256 * 1024;

function parseDescriptors(lines: string[]): BridgeDescriptor[] {
  return lines.flatMap((line) => { try { return [JSON.parse(line) as BridgeDescriptor]; } catch { return []; } });
}

/** sha256 asset upload, both-sides verification, extraction, atomic activation: shared by both hosts. */
async function fetchBundle(platform: string, signal: AbortSignal, options: InstallOptions) {
  const report = options.onProgress ?? (() => {});
  const asset = await bundleFile(platform, signal, { cacheDir: options.cacheDir, onProgress: (done, total) => report("download", done, total) });
  report("upload", 0, asset.size);
  return { asset, input: { path: asset.path, onProgress: (done: number) => report("upload", done, asset.size), onUploaded: () => report("install", 0, null) } };
}

export const posixHost: RemoteHost = {
  kind: "posix",
  bundleDescription: "Private web bridge bundle (Bun, Node and node-pty; no build tools needed)",
  logHint: "~/.config/herdr-web-ui/bridges/bridge.log",
  async inspect(ssh, session, socket) {
    const inspection = await ssh.run(REMOTE_PATH + `printf '%s\\n' "$(uname -s)" "$(uname -m)" "$(cd -P "$HOME" && pwd -P)" "\${XDG_CONFIG_HOME:-$HOME/.config}" "$(command -v herdr || true)"; test -x "$HOME/${BUNDLE_DIR}/bin/bun" && printf 'bundle-ready\\n' || true; for d in "$HOME/.local/share/herdr-web-ui/remote-v"*; do if test -x "$d/bin/bun"; then printf 'bundle-older\\n'; break; fi; done; for f in "$HOME/.config/herdr-web-ui/bridges/"*.json; do test ! -f "$f" || cat "$f"; printf '\\n'; done`);
    const [os, arch, home, xdgConfig, herdrPath, ...lines] = inspection.split("\n");
    if (!["Linux", "Darwin"].includes(os ?? "") || !["x86_64", "aarch64", "arm64"].includes(arch ?? "")) throw new Error(UNSUPPORTED_HOST);
    if (!home?.startsWith("/")) throw new Error("The SSH account's home directory ($HOME) could not be read on this PC");
    // the same XDG_CONFIG_HOME rule remote-entry.ts and herdr itself follow
    const herdrConfig = `${xdgConfig?.startsWith("/") ? xdgConfig : `${home}/.config`}/herdr`;
    if (socket !== undefined && !validHerdrSocket(socket)) throw new Error("Invalid herdr socket path");
    const sessionSocket = session ? `${herdrConfig}/sessions/${session}/herdr.sock` : `${herdrConfig}/herdr.sock`;
    const spelled = (nominal: string) => ssh.run(`socket=${shellQuote(nominal)}; if test -d "\${socket%/*}"; then cd -P "\${socket%/*}" && printf '%s/herdr.sock' "$PWD"; else printf '%s' "$socket"; fi`);
    const expectedSocket = await spelled(socket ?? sessionSocket);
    const defaultSocket = socket === undefined ? expectedSocket : await spelled(sessionSocket);
    return {
      platform: `${os === "Darwin" ? "darwin" : "linux"}-${arch === "x86_64" ? "x64" : "arm64"}`,
      home, herdrPath: herdrPath ?? "", expectedSocket, defaultSocket,
      bundleReady: lines.includes("bundle-ready"), bundleOlder: lines.includes("bundle-older"),
      descriptors: parseDescriptors(lines),
      runtimeDir: `${home}/${BUNDLE_DIR}`, registryDir: `${home}/.config/herdr-web-ui/bridges`,
    };
  },
  herdrVersion: (ssh, herdrPath) => ssh.run(`${shellQuote(herdrPath)} --version`),
  alive: async (ssh, pid) => await ssh.run(`kill -0 ${pid} 2>/dev/null && printf live || true`) === "live",
  async authorizeKey(ssh, keyLine) {
    await ssh.run(`set -eu; umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; key=${shellQuote(keyLine)}; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf '\\n%s\\n' "$key" >> "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"`);
  },
  async installBundle(ssh, platform, signal, options = {}) {
    const { asset, input } = await fetchBundle(platform, signal, options);
    // Verify on BOTH hosts, extract into staging and atomically rename. No user-wide
    // Bun/Node/herdr installation is changed; the complete runtime lives in this dir.
    await ssh.run(`set -eu; umask 077; base="$HOME/.local/share/herdr-web-ui"; mkdir -p "$base"; ${POSIX_INSTALL_LOCK} tmp=$(mktemp -d "$base/install.XXXXXX"); trap 'rm -rf "$tmp"; ${POSIX_INSTALL_RELEASE}' EXIT HUP INT TERM; if command -v timeout >/dev/null; then timeout ${INSTALL_UPLOAD_TIMEOUT_S} cat > "$tmp/bundle.tgz"; else cat > "$tmp/bundle.tgz"; fi; if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/bundle.tgz" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$tmp/bundle.tgz" | cut -d ' ' -f 1); fi; test "$actual" = ${shellQuote(asset.sha256)}; mkdir "$tmp/runtime"; tar xzf "$tmp/bundle.tgz" -C "$tmp/runtime"; test -x "$tmp/runtime/bin/bun"; test -x "$tmp/runtime/bin/node"; test -x "$tmp/runtime/bin/herdr"; "$tmp/runtime/bin/bun" --version; "$tmp/runtime/bin/herdr" --version; "$tmp/runtime/bin/node" "$tmp/runtime/server/pty/smoke.mjs"; release="$HOME/${BUNDLE_DIR}-${asset.sha256.slice(0, 16)}"; if test ! -d "$release"; then mv "$tmp/runtime" "$release"; fi; ln -s "$release" "$tmp/current"; if test -d "$HOME/${BUNDLE_DIR}" && test ! -L "$HOME/${BUNDLE_DIR}"; then mv "$HOME/${BUNDLE_DIR}" "$HOME/${BUNDLE_DIR}-legacy-$(date +%s)"; fi; "$release/bin/bun" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$tmp/current" "$HOME/${BUNDLE_DIR}"`, input, 30 * 60_000);
  },
  stop: async (ssh, pid) => { await ssh.run(`kill -TERM ${pid}`); },
  async start(ssh, { session, herdrPath, inspection, herdr_socket, start_new_herdr }) {
    // a bundle published before the rename reads HERDR_WEB_HERDR_BIN
    const remoteHerdr = shellQuote(herdrPath || `${inspection.home}/${BUNDLE_DIR}/bin/herdr`);
    if (herdr_socket !== undefined && !validHerdrSocket(herdr_socket)) throw new Error("Invalid herdr socket path");
    inspection.startupResult = `${inspection.registryDir}/startup-${randomUUID()}.result`;
    await ssh.run(REMOTE_PATH + `umask 077; mkdir -p "$HOME/.config/herdr-web-ui/bridges"; HERDR_REMOTE_SESSION=${shellQuote(session ?? "")} HERDR_REMOTE_SOCKET=${shellQuote(herdr_socket ?? "")} HERDR_REMOTE_START_NEW=${shellQuote(start_new_herdr ? "1" : "")} HERDR_REMOTE_RESULT=${shellQuote(inspection.startupResult)} OVIS_HERDR_BIN=${remoteHerdr} HERDR_WEB_HERDR_BIN=${remoteHerdr} nohup "$HOME/${BUNDLE_DIR}/bin/bun" "$HOME/${BUNDLE_DIR}/server/remote-entry.ts" </dev/null >>"$HOME/.config/herdr-web-ui/bridges/bridge.log" 2>&1 &`);
  },
  async foundSessions(ssh, inspection) {
    if (!inspection.startupResult) return null;
    const path = shellQuote(inspection.startupResult);
    const text = await ssh.run(`if test -f ${path}; then head -c 1048576 ${path}; rm -f ${path}; fi`);
    if (!text) return null;
    const result: unknown = JSON.parse(text);
    if (typeof result !== "object" || result === null || !("code" in result) || (result.code !== "herdr_sessions_found" && result.code !== "herdr_session_gone") || !("sessions" in result)) throw new Error("The PC returned an invalid startup result");
    const gone = result.code === "herdr_session_gone";
    // a stopped chosen session may leave no other one running
    return { gone, sessions: gone && Array.isArray(result.sessions) && result.sessions.length === 0 ? [] : parseFoundHerdrSessions(result.sessions) };
  },
  async discoverSessions(ssh, inspection) {
    const script = `import { discoverHerdrSessions } from ${JSON.stringify(inspection.runtimeDir + "/server/herdr-discovery.ts")}; console.log(JSON.stringify(await discoverHerdrSessions()));`;
    // at most 256 sessions of a few hundred bytes each: an answer past the cap is stopped and refused, never parsed
    const text = await ssh.run(`if test -x ${shellQuote(inspection.runtimeDir + "/bin/bun")}; then ${shellQuote(inspection.runtimeDir + "/bin/bun")} -e ${shellQuote(script)}; else printf '[]'; fi`, undefined, undefined, DISCOVERY_OUTPUT_BYTES);
    const sessions: unknown = JSON.parse(text);
    return Array.isArray(sessions) && sessions.length === 0 ? [] : parseFoundHerdrSessions(sessions);
  },
  async chosenSocketStatus(ssh, inspection, socket) {
    // the installed bundle holds the rule; an older or missing one cannot say
    if (!inspection.bundleReady || !validHerdrSocket(socket)) return null;
    const status = (await ssh.run(REMOTE_PATH + `HERDR_CHECK_SOCKET=${shellQuote(socket)} "$HOME/${BUNDLE_DIR}/bin/bun" -e 'const { chosenHerdrSocketStatus } = await import(process.env.HOME + "/${BUNDLE_DIR}/server/herdr-discovery.ts"); console.log(await chosenHerdrSocketStatus(process.env.HERDR_CHECK_SOCKET))' 2>/dev/null || true`)).trim();
    return status === "usable" || status === "gone" || status === "refused" ? status : null;
  },
  async descriptors(ssh) {
    return parseDescriptors((await ssh.run(`for f in "$HOME/.config/herdr-web-ui/bridges/"*.json; do test ! -f "$f" || cat "$f"; printf '\\n'; done`)).split("\n"));
  },
};

export { psQuote };
/** A cmd.exe `set "NAME=value"` cannot hold a quote; nothing legitimate here has one. */
function cmdValue(value: string): string {
  if (/["\r\n\0%!]/.test(value)) throw new Error("Invalid characters for a remote path");
  return value;
}

/**
 * A bridge's log and launcher on Windows, one pair per herdr session. cmd holds the file it
 * redirects into, so a second bridge sent to the same log never starts: "The process cannot
 * access the file because it is being used by another process" (live-verified).
 */
export function windowsBridgeFiles(session?: string): { log: string; launcher: string; status: string } {
  const suffix = session ? `-${session}` : "";
  return { log: `bridge${suffix}.log`, launcher: `start-bridge${suffix}.cmd`, status: `bridge${suffix}.startup` };
}

const WINDOWS_BUNDLE = `${WINDOWS_BUNDLE_BASE}\\remote-v${REMOTE_BUNDLE_VERSION}`;
// Windows PowerShell's .NET file APIs can reject the migration junction as an untrusted mount point.
const WINDOWS_REGISTRY = `$(
  $registryRoot = "$env:USERPROFILE\\.config\\herdr-web-ui"
  $registryItem = Get-Item -LiteralPath $registryRoot -Force -ErrorAction SilentlyContinue
  if ($registryItem.LinkType -eq 'Junction') { $registryRoot = @($registryItem.Target)[0] }
  Join-Path $registryRoot 'bridges'
)`;
// a script's exit code follows its last statement: a listing of a registry not there yet must
// not count as a failure, so the directory is checked first
const WINDOWS_DESCRIPTORS = `if (Test-Path -LiteralPath "${WINDOWS_REGISTRY}") { Get-ChildItem -LiteralPath "${WINDOWS_REGISTRY}" -Filter *.json | ForEach-Object { Write-Output (Get-Content -LiteralPath $_.FullName -Raw) } }; Write-Output ''`;

export const windowsHost: RemoteHost = {
  kind: "windows",
  bundleDescription: "Private web bridge bundle (Bun only: herdr owns every terminal on Windows)",
  logHint: "%USERPROFILE%\\.config\\herdr-web-ui\\bridges\\bridge.log (bridge-<session>.log for a named session)",
  async inspect(ssh, session) {
    const inspection = await ssh.runPowerShell([
      "$ErrorActionPreference = 'Continue'",
      // herdr's installer keeps a stable alias here (PATH's herdr.exe is one versioned release,
      // which the next update replaces); a fresh sshd session may not have the PATH it added yet
      "$herdr = \"$env:LOCALAPPDATA\\Programs\\Herdr\\bin\\herdr.exe\"",
      "if (-not (Test-Path $herdr)) { $herdr = (Get-Command herdr.exe -ErrorAction SilentlyContinue).Source }",
      "Write-Output 'Windows'; Write-Output $env:PROCESSOR_ARCHITECTURE; Write-Output $env:USERPROFILE; Write-Output $env:APPDATA; if ($env:XDG_CONFIG_HOME) { Write-Output $env:XDG_CONFIG_HOME } else { Write-Output '' }; Write-Output $env:LOCALAPPDATA; Write-Output \"$herdr\"",
      `if (Test-Path "${WINDOWS_BUNDLE}\\bin\\bun.exe") { Write-Output 'bundle-ready' }`,
      `if (Get-ChildItem "${WINDOWS_BUNDLE_BASE}" -Directory -Filter 'remote-v*' -ErrorAction SilentlyContinue | Where-Object { Test-Path "$($_.FullName)\\bin\\bun.exe" }) { Write-Output 'bundle-older' }`,
      WINDOWS_DESCRIPTORS,
    ].join("\n"));
    const [os, arch, home, appData, xdgConfigHome, localAppData, herdrPath, ...lines] = inspection.split("\n");
    if (os !== "Windows" || arch !== "AMD64") throw new Error(UNSUPPORTED_HOST);
    const drive = /^[A-Za-z]:[\\/]/;
    if (xdgConfigHome && !drive.test(xdgConfigHome)) throw new Error("The SSH account's XDG_CONFIG_HOME could not be read on this PC");
    if (!home || !drive.test(home) || !localAppData || !drive.test(localAppData)) throw new Error("The SSH account's profile directory (%USERPROFILE%) could not be read on this PC");
    const herdrConfig = xdgConfigHome || appData;
    if (!herdrConfig || !drive.test(herdrConfig)) throw new Error("The SSH account's herdr configuration directory could not be read on this PC");
    const herdrDir = win32.join(herdrConfig, "herdr");
    return {
      platform: "win32-x64", home, herdrPath: herdrPath ?? "",
      // the marker file's own path: the bridge's realpath of it is the same string (live-verified)
      expectedSocket: session ? win32.join(herdrDir, "sessions", session, "herdr.sock") : win32.join(herdrDir, "herdr.sock"),
      bundleReady: lines.includes("bundle-ready"), bundleOlder: lines.includes("bundle-older"),
      descriptors: parseDescriptors(lines),
      runtimeDir: `${localAppData}\\herdr-web-ui\\remote-v${REMOTE_BUNDLE_VERSION}`, registryDir: `${home}\\.config\\herdr-web-ui\\bridges`,
    };
  },
  herdrVersion: (ssh, herdrPath) => ssh.runPowerShell(`& ${psQuote(herdrPath)} --version`),
  alive: async (ssh, pid) => (await ssh.runPowerShell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output 'live' }`)).trim() === "live",
  async authorizeKey(ssh, keyLine) {
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$key = ${psQuote(keyLine)}`,
      "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      // sshd reads an administrator's keys from one shared file with a fixed ACL; SIDs, since the group's name is localized
      "if ($admin) { $file = \"$env:ProgramData\\ssh\\administrators_authorized_keys\" } else { New-Item -ItemType Directory -Force \"$env:USERPROFILE\\.ssh\" | Out-Null; $file = \"$env:USERPROFILE\\.ssh\\authorized_keys\" }",
      "if (-not (Test-Path $file)) { New-Item -ItemType File $file | Out-Null }",
      // a last line without its newline would take the key onto itself (Add-Content only ends what it adds)
      "if (@(Get-Content $file) -notcontains $key) { $raw = [IO.File]::ReadAllText($file); if ($raw.Length -gt 0 -and -not $raw.EndsWith(\"`n\")) { Add-Content -Path $file -Value '' -Encoding ascii }; Add-Content -Path $file -Value $key -Encoding ascii }",
      // sshd refuses the file while anyone but Administrators and SYSTEM may write it: a grant
      // to Users, Authenticated Users or Everyone that the file already had goes too
      "if ($admin) { icacls $file /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' /remove:g '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Could not set the permissions of administrators_authorized_keys' } }",
    ].join("\n"));
  },
  async installBundle(ssh, platform, signal, options = {}) {
    const { asset, input } = await fetchBundle(platform, signal, options);
    const release = `${WINDOWS_BUNDLE}-${asset.sha256.slice(0, 16)}`;
    const base = (await ssh.runPowerShell(`Write-Output "${WINDOWS_BUNDLE_BASE}"`)).trim();
    if (!/^[A-Za-z]:\\/.test(base)) throw new Error("%LOCALAPPDATA% could not be read on this PC");
    const reclaim = options.owner ?? installLockOwner("", ssh.target);
    await withWindowsInstallAttempt(reclaim, async (owner) => {
      // the same shape as the POSIX install: verify here and there, stage, then swap the
      // `remote-vN` junction (no privilege needed, unlike a symlink). The upload is its own
      // step (sftp, see SshConnection.upload), so the lock is taken around it by hand.
      const stage = `${base}\\install.${process.pid}`;
      await ssh.runPowerShell([
        "$ErrorActionPreference = 'Stop'",
        `New-Item -ItemType Directory -Force ${psQuote(base)} | Out-Null`,
        `$base = ${psQuote(base)}`,
        `$reclaim = ${psQuote(reclaim)}`,
        `$owner = ${psQuote(owner)}`,
        WINDOWS_INSTALL_LOCK,
        `New-Item -ItemType Directory -Force ${psQuote(stage)} | Out-Null`,
      ].join("\n"));
      const archive = `${stage}\\bundle.tgz`;
      const cleanup = () => ssh.runPowerShell(`Remove-Item -Recurse -Force ${psQuote(stage)} -ErrorAction SilentlyContinue; $base = ${psQuote(base)}; $owner = ${psQuote(owner)}; ${WINDOWS_INSTALL_RELEASE}`).catch(() => {});
      try {
        // sftp says nothing about how far it is: the file's size on the PC does
        const upload = ssh.upload(input.path, archive, INSTALL_UPLOAD_TIMEOUT_S * 1000);
        let settled = false;
        void upload.finally(() => { settled = true; });
        while (!settled) {
          await Promise.race([upload.catch(() => {}), Bun.sleep(2000)]);
          if (settled) break;
          const size = Number((await ssh.runPowerShell(`(Get-Item ${psQuote(archive)} -ErrorAction SilentlyContinue).Length`).catch(() => "")).trim());
          if (Number.isFinite(size) && size > 0) input.onProgress?.(size);
        }
        await upload;
        input.onProgress?.(asset.size);
        input.onUploaded?.();
      } catch (error) { await cleanup(); throw error; }
      await ssh.runPowerShell([
        "$ErrorActionPreference = 'Stop'",
        `$base = ${psQuote(base)}`,
        `$owner = ${psQuote(owner)}`,
        `$tmp = ${psQuote(stage)}`,
        "try {",
        `  if ((Get-FileHash -Algorithm SHA256 "$tmp\\bundle.tgz").Hash.ToLower() -ne '${asset.sha256}') { throw 'Remote bundle checksum mismatch' }`,
        "  New-Item -ItemType Directory \"$tmp\\runtime\" | Out-Null",
        // Git's GNU tar on PATH interprets a drive-letter archive as a remote host.
        "  & \"$env:SystemRoot\\System32\\tar.exe\" -xzf \"$tmp\\bundle.tgz\" -C \"$tmp\\runtime\"; if ($LASTEXITCODE -ne 0) { throw 'Bundle extraction failed' }",
        "  & \"$tmp\\runtime\\bin\\bun.exe\" --version | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Bundled Bun does not run on this PC' }",
        `  $release = "${release}"`,
        "  if (-not (Test-Path $release)) { Move-Item \"$tmp\\runtime\" $release }",
        `  $current = "${WINDOWS_BUNDLE}"`,
        "  if (Test-Path $current) { if ((Get-Item $current).Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($current) } else { Move-Item $current \"$current-legacy-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())\" } }",
        "  New-Item -ItemType Junction -Path $current -Target $release | Out-Null",
        `} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; ${WINDOWS_INSTALL_RELEASE} }`,
      ].join("\n"), undefined, INSTALL_EXTRACT_TIMEOUT_MS);
    });
  },
  async installHerdr(ssh) {
    // herdr's stable installer (the one its docs give for endpoint-security-blocked PowerShell)
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      "$tmp = Join-Path $env:TEMP \"herdr-install-$PID\"; New-Item -ItemType Directory -Force $tmp | Out-Null",
      `curl.exe -fsSLo "$tmp\\install.cmd" ${HERDR_INSTALL_CMD}; if ($LASTEXITCODE -ne 0) { throw 'Could not download the herdr installer' }`,
      "& cmd.exe /d /c \"$tmp\\install.cmd\"; if ($LASTEXITCODE -ne 0) { throw 'The herdr installer failed' }",
      "Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue",
    ].join("\n"), undefined, 10 * 60_000);
    const herdr = (await ssh.runPowerShell("Write-Output \"$env:LOCALAPPDATA\\Programs\\Herdr\\bin\\herdr.exe\"")).trim();
    if (!/^[A-Za-z]:\\/.test(herdr)) throw new Error("herdr's installer left no herdr.exe behind");
    return herdr;
  },
  // no SIGTERM on Windows, so the bridge cannot withdraw its descriptor itself; a stale one
  // left here would be found before the next bridge writes its own
  stop: async (ssh, pid) => {
    await ssh.runPowerShell([
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
      `if (Test-Path -LiteralPath "${WINDOWS_REGISTRY}") { Get-ChildItem -LiteralPath "${WINDOWS_REGISTRY}" -Filter *.json | ForEach-Object { try { if ((Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).pid -eq ${pid}) { Remove-Item -LiteralPath $_.FullName -Force } } catch {} } }`,
      "Write-Output ''",
    ].join("\n"));
  },
  async start(ssh, { session, herdrPath, inspection, headless }) {
    if (!herdrPath) throw new Error("herdr is not installed on this PC");
    const files = windowsBridgeFiles(session);
    // a launcher script: cmd can set the environment and redirect the log without any
    // quoting the WMI command line would have to survive
    const launcher = [
      "@echo off",
      // the paths below are UTF-8: a profile such as C:\Users\홍길동 is lost in an ANSI batch file
      "chcp 65001 >nul",
      `set "HERDR_REMOTE_SESSION=${cmdValue(session ?? "")}"`,
      `set "OVIS_WINDOWS_HEADLESS_START=${headless ? "1" : ""}"`,
      `set "OVIS_HERDR_BIN=${cmdValue(herdrPath)}"`,
      `set "HERDR_WEB_HERDR_BIN=${cmdValue(herdrPath)}"`,
      `cd /d "${cmdValue(inspection.home)}" || exit /b 1`,
      `"${cmdValue(`${inspection.runtimeDir}\\bin\\bun.exe`)}" "${cmdValue(`${inspection.runtimeDir}\\server\\remote-entry.ts`)}" >> "${cmdValue(`${inspection.registryDir}\\${files.log}`)}" 2>&1`,
    ];
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$dir = "${WINDOWS_REGISTRY}"; New-Item -ItemType Directory -Force $dir | Out-Null`,
      // one literal per line: WriteAllLines ends each with the CRLF cmd expects
      `[IO.File]::WriteAllLines("$dir\\${files.launcher}", [string[]]@(${launcher.map(psQuote).join(", ")}), (New-Object Text.UTF8Encoding $false))`,
      // the previous attempt's startup status must not answer for this one: the new bridge
      // clears it only once it has loaded, after the manager's first status read
      `Remove-Item -LiteralPath "$dir\\${files.status}" -Force -ErrorAction SilentlyContinue`,
      // not Start-Process: that child belongs to the SSH session's job and dies with it
      // Keep the resolved path out of cmd's command line: even quoted %NAME% would expand.
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(`cmd.exe /d /c ".\\${files.launcher}"`)}; CurrentDirectory = $dir }`,
      "if ($r.ReturnValue -ne 0) { throw \"Could not start the bridge (Win32_Process.Create returned $($r.ReturnValue))\" }",
    ].join("\n"));
  },
  async startupNotice(ssh, session) {
    const suffix = session ? `-${session}` : "";
    const name = psQuote(`bridge${suffix}.startup`);
    const result = await ssh.runPowerShell(`$status = Join-Path "${WINDOWS_REGISTRY}" ${name}; if (Test-Path -LiteralPath $status) { [IO.File]::ReadAllText($status) }`);
    const status = result.trim();
    if (status === "waiting_login") return WAITING_FOR_WINDOWS_LOGIN;
    if (status.startsWith("interactive_failed: ")) return status.slice("interactive_failed: ".length);
    return null;
  },
  async descriptors(ssh) {
    return parseDescriptors((await ssh.runPowerShell(WINDOWS_DESCRIPTORS)).split("\n"));
  },
};

/**
 * Which shell the PC answers to. sh first (every Linux and macOS host); a host that
 * cannot run it is asked in PowerShell, and one that answers neither gets sh's own error,
 * which names the real problem (a refused connection, a wrong key).
 */
export async function detectHost(ssh: SshConnection, session?: string, socket?: string): Promise<{ host: RemoteHost; inspection: HostInspection }> {
  let posixError: unknown;
  try { return { host: posixHost, inspection: await posixHost.inspect(ssh, session, socket) }; }
  catch (error) { posixError = error; }
  try { return { host: windowsHost, inspection: await windowsHost.inspect(ssh, session) }; }
  catch (error) {
    if (error instanceof Error && error.message === UNSUPPORTED_HOST) throw error;
    throw posixError instanceof Error ? posixError : new Error(String(posixError));
  }
}
