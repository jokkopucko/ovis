import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { version } from "../package.json";
import type { PcInstallFailure, PcInstallJob, SshTarget } from "../shared/machines.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { shellQuote } from "./machine-security.ts";
import { parseBirth, type ProcessBirth } from "./process-owner.ts";
import { posixHost, REMOTE_PATH } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { samePc } from "./ssh-address.ts";
import { isCoreAdapterSocket } from "./herdr-core/pipe.ts";

/**
 * SSH uses keys only (BatchMode): nothing asks for a password. herdr, its sessions and the user's settings files are
 * never touched; only the server named in the plan is stopped.
 */

export const INSTALLER = "https://ovis.sh/install.sh";
/** the installer of one release, from its own tag: the same script as INSTALLER, at the release it installs, never a newer copy */
export const installerAt = (release: string): string => `https://raw.githubusercontent.com/devswha/ovis/${release}/install.sh`;
const MIN_FREE_KB = 1024 * 1024;
/** the installer clones and builds Ovis (about a minute), and may install herdr and Bun first */
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const STOP_WAIT_MS = 15_000;

const DOWNLOAD_FAILED = "Ovis: could not download the installer of";
const CHANGED_WORDS = "That PC's Ovis changed since it was looked at, so nothing was stopped. Reconnect it and try again.";
const NOT_REGISTERED_WORDS = (pid: number) => `The process ${pid} on that PC started after that Ovis registered, so it may be another program that took its process id; nothing was stopped. Reconnect it and try again.`;
/** a folder captureServer made: only such a path is ever put back into a command (quoted) */
export const SAVED_SERVER = /^\/[^\n\0]*\/ovis-restore\.[A-Za-z0-9]{8}$/;
/** how long a copy may stay on that PC whatever becomes of the install (this server stopping mid-job, say) */
const SAVED_FOR_S = 2 * 60 * 60;
const COPY_CHECK = "const { readFileSync, readlinkSync } = require(\"node:fs\");\nconst d = process.argv.at(-1);\nconst same = (bytes) => Buffer.from(bytes.toString()).equals(bytes);\nfor (const name of [\"cmdline\", \"environ\"]) if (!same(readFileSync(d + \"/\" + name))) process.exit(1);\nfor (const name of [\"cwd\", \"exe\"]) if (!same(readlinkSync(d + \"/\" + name, { encoding: \"buffer\" }))) process.exit(1);";
/**
 * Before a server started by hand is stopped, its exact command line, environment (its OVIS_TOKEN with the rest), folder
 * and program are copied from Linux's /proc into a folder only this account can read: the folder and program as the
 * symlinks /proc has (cp -P), so no byte of their paths is lost. It prints that folder; "error" when copying failed this
 * time (nothing is then stopped: try again); "unfaithful" when no copy of it can be faithful (its environment unreadable,
 * its program deleted since it started, as after a Bun upgrade, or bytes that would not survive being started again), and
 * nothing where there is no /proc (macOS): in both, it is stopped without a copy and never started again with a guess. The copy
 * holds a token, so it removes itself after SAVED_FOR_S whatever happens to this job (systemd-run where it can, so it
 * outlives the SSH session), and each capture sweeps this account's copies older than that.
 */
export const captureServer = (pid: number, identity: string): string =>
  // copies of this account's older than the lease, left by a job whose cleanup never ran, go first
  `find "${'${TMPDIR:-/tmp}'}" -maxdepth 1 -name 'ovis-restore.*' -user "$(id -u)" -mmin +${SAVED_FOR_S / 60} -exec rm -rf {} + 2>/dev/null; `
  // still the very process the plan was made for (its start and its owner): a pid reused since is never copied
  + `${sameProcess(pid, identity)} || { echo changed; exit 0; }; `
  + `[ -d /proc/self ] || exit 0; [ -r /proc/${pid}/environ ] || { echo unfaithful; exit 0; }; umask 077; d=$(mktemp -d "${'${TMPDIR:-/tmp}'}/ovis-restore.XXXXXXXX") || { echo error; exit 0; }; `
  // a copy cut short (this SSH connection lost) leaves nothing behind
  + `trap 'rm -rf "$d"' HUP INT TERM PIPE; trap '[ -n "$kept" ] || rm -rf "$d"' EXIT; `
  + `if ! { cp /proc/${pid}/cmdline "$d/cmdline" && cp /proc/${pid}/environ "$d/environ" && cp -P /proc/${pid}/cwd "$d/cwd" && cp -P /proc/${pid}/exe "$d/exe" && [ -s "$d/cmdline" ]; }; then echo error; exit 0; fi; `
  + `if case "$(readlink "$d/exe")$(readlink "$d/cwd")" in *' (deleted)'*) false;; *) true;; esac && [ -d "$d/cwd/" ] && "$d/exe" -e ${shellQuote(COPY_CHECK)} "$d" >/dev/null 2>&1; then `
  + `if ! { command -v systemd-run >/dev/null 2>&1 && systemd-run --user --quiet --on-active=${SAVED_FOR_S} rm -rf "$d" >/dev/null 2>&1; }; then `
  + `if command -v setsid >/dev/null 2>&1; then l=setsid; else l=nohup; fi; ($l sh -c 'sleep ${SAVED_FOR_S}; rm -rf "$1"' ovis-restore-lease "$d" </dev/null >/dev/null 2>&1 &); fi; `
  // kept only once its path is told: an SSH connection closed before that leaves no copy behind
  + `printf '%s\\n' "$d" && kept=1; else echo unfaithful; fi`;
/**
 * what tells one process from another that took its pid since: on Linux its start in clock ticks since boot (/proc/<pid>/stat)
 * and its owner; on macOS, which has no /proc, ps's start time to the second and owner (a pid reused within that second
 * stays the residual there)
 */
export const processIdentity = (pid: number): string =>
  `id_of=${pid}; if [ -r /proc/$id_of/stat ]; then printf '%s %s' "$(sed 's/.*) //' /proc/$id_of/stat | cut -d' ' -f20)" "$(stat -c %u /proc/$id_of)"; else ps -o lstart= -o uid= -p $id_of 2>/dev/null | sed 's/^ *//;s/ *$//'; fi`;
/**
 * A shell test that the process at that pid is the very one a bridge registration recorded (its birth, as
 * server/process-owner.ts reads it: on Linux this boot's id and its start in clock ticks, on macOS ps's start time in UTC),
 * not another that took the pid after it ended. No birth recorded (an older server's registration): nothing to test.
 */
export const bornAs = (pid: number, birth: ProcessBirth | undefined): string =>
  !birth ? "true"
  : birth.platform === "linux" ? `[ "$(born_of=${pid}; printf '%s:%s' "$(cat /proc/sys/kernel/random/boot_id)" "$(sed 's/.*) //' /proc/$born_of/stat 2>/dev/null | cut -d' ' -f20)")" = ${shellQuote(birth.value)} ]`
  : birth.platform === "darwin" ? `[ "$(born_of=${pid}; LC_ALL=C TZ=UTC ps -o lstart= -p $born_of 2>/dev/null | sed 's/^ *//;s/ *$//;s/  */ /g')" = ${shellQuote(birth.value)} ]`
  : "false";
/**
 * A shell test, for a registration that recorded no birth (every 0.5.x bridge's), that the process at that pid started
 * no later than its registration file was written (2 s of slack): the server writes it after it starts, so a process
 * that took the pid after that server ended started later. Its file is the one the shell variable `f` names, so no token
 * is on any command line. Linux and macOS: ps's elapsed time, the file's mtime, the clock now.
 */
const startedBeforeFile = (pid: number): string =>
  `{ reg_of=${pid}; m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") && `
  + `e=$(ps -o etime= -p $reg_of 2>/dev/null | awk '{ n = split($1, a, /[-:]/); if (index($1, "-")) print a[1]*86400 + a[2]*3600 + a[3]*60 + a[4]; else if (n == 3) print a[1]*3600 + a[2]*60 + a[3]; else print a[1]*60 + a[2] }') && `
  + `[ -n "$e" ] && [ $(( $(date +%s) - e )) -le $(( m + 2 )) ]; }`;
export const birthNow = (pid: number, platform: string | undefined): string =>
  // only on the platform the birth was recorded on (macOS has no /proc), and only when every part of it reads
  platform === "darwin" ? `[ -d /proc/self ] || LC_ALL=C TZ=UTC ps -o lstart= -p ${pid} 2>/dev/null | sed 's/^ *//;s/ *$//;s/  */ /g' | tr -d '\\n'`
  : platform === undefined || platform === "linux" ? `if [ -d /proc/self ]; then b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null); k=$(sed 's/.*) //' /proc/${pid}/stat 2>/dev/null | cut -d' ' -f20); [ -n "$b" ] && [ -n "$k" ] && printf '%s:%s' "$b" "$k"; fi; true`
  : "true";
/** a shell test that a process runs at that pid, and has not ended (a zombie, not yet reaped, serves nothing) */
// alive by kill -0; ended only on positive evidence (kill -0 fails, or ps reports a zombie): a PC whose ps lacks -o or -p
// (BusyBox, a minimal image) never makes a running server look gone
export const runs = (pid: number): string => `kill -0 ${pid} 2>/dev/null && ! ps -o stat= -p ${pid} 2>/dev/null | grep -q '^ *Z'`;
/** A birth recorded but not in its shape (read as raw JSON from the PC) is no identity: nothing passes as it */
export const registeredIn = (pid: number, birth: unknown): string => {
  if (birth === undefined) return startedBeforeFile(pid);
  const parsed = parseBirth(birth);
  return parsed ? bornAs(pid, parsed) : "false";
};
/**
 * The very server a registration names, without its token on any command line (another account on that PC can read a
 * process's arguments): its file, named after its socket as server/bridge.ts descriptorPath names it, still names that
 * pid, and the process at that pid is the one it recorded (registeredIn).
 */
export const registeredAs = (pid: number, descriptor: { birth?: unknown; socket_path: string }): string =>
  `{ f="$HOME/.config/herdr-web-ui/bridges/${createHash("sha256").update(descriptor.socket_path).digest("hex")}.json"; [ -f "$f" ] && [ ! -L "$f" ] && `
  + `grep -Eq ${shellQuote(`"pid"[[:space:]]*:[[:space:]]*${pid}([^0-9]|$)`)} "$f" && ${registeredIn(pid, descriptor.birth)}; }`;
export const sameProcess = (pid: number, identity: string): string => `[ -n ${shellQuote(identity)} ] && [ "$(${processIdentity(pid)})" = ${shellQuote(identity)} ]`;
const RESTORE_LAUNCHER = "const { readFileSync, readlinkSync, rmSync, openSync, fstatSync, fchmodSync, closeSync, mkdirSync, constants } = require(\"node:fs\");\nconst { spawn } = require(\"node:child_process\");\nconst { createServer } = require(\"node:net\");\nconst d = process.argv.at(-1);\nconst parts = (name) => { const b = readFileSync(d + \"/\" + name); const out = []; let at = 0; for (let i = 0; i < b.length; i++) if (b[i] === 0) { out.push(b.subarray(at, i).toString()); at = i + 1; } if (at < b.length) out.push(b.subarray(at).toString()); return out; };\n(async () => {\n  try {\n    const argv = parts(\"cmdline\"); const env = {};\n    for (const entry of parts(\"environ\")) { const eq = entry.indexOf(\"=\"); if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1); }\n    const exe = readlinkSync(d + \"/exe\"), cwd = readlinkSync(d + \"/cwd\");\n    const host = env.HOST || \"127.0.0.1\", loopback = [\"\", \"127.0.0.1\", \"localhost\"].includes(host), port = (loopback && Number(process.argv.at(-2))) || Number(env.PORT || __DEFAULT_PORT__);\n    const free = await new Promise((resolve) => { const probe = createServer(); probe.once(\"error\", (error) => resolve(error.code === \"EADDRINUSE\" ? false : error)); probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true))); });\n    if (free === false) { console.log(\"taken\"); return; }\n    if (free !== true) throw new Error(\"its address \" + host + \":\" + port + \" cannot be used: \" + (free.code || free.message));\n    const logs = (process.env.XDG_STATE_HOME || process.env.HOME + \"/.local/state\") + \"/ovis\";\n    mkdirSync(logs, { recursive: true, mode: 0o700 });\n    const log = openSync(logs + \"/restored-server.log\", constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);\n    const info = fstatSync(log);\n    if (!info.isFile() || info.uid !== process.getuid()) { closeSync(log); throw new Error(\"its log is not this account's own file\"); }\n    fchmodSync(log, 0o600);\n    const child = spawn(exe, argv.slice(1), { argv0: argv[0], cwd, env, detached: true, stdio: [\"ignore\", log, log] });\n    await new Promise((resolve, reject) => { child.once(\"spawn\", resolve); child.once(\"error\", reject); });\n    child.unref();\n    // its pid and its birth (this boot and its start ticks, as server/process-owner.ts records it): another process that takes the pid later is not it\n    let birth = \"\";\n    try { const stat = readFileSync(\"/proc/\" + child.pid + \"/stat\", \"utf8\"); birth = readFileSync(\"/proc/sys/kernel/random/boot_id\", \"utf8\").trim() + \":\" + stat.slice(stat.lastIndexOf(\") \") + 2).split(\" \")[19]; } catch {}\n    console.log(child.pid + \" \" + birth);\n  } catch (error) { console.error(String(error && error.message || error)); process.exitCode = 1; }\n  finally { rmSync(d, { recursive: true, force: true }); }\n})();".replace("__DEFAULT_PORT__", String(DEFAULT_PORT));
/**
 * Starts the server captureServer copied again, as it was: its own program, the same arguments, in the same folder, with
 * exactly its environment, given to the new process directly (never on any command line, where another account could
 * read the token), in a session of its own so it outlives this SSH connection, its output in a log only this account
 * reads. Its address (HOST, PORT) is bound first: one already taken means a live server is there, its replacement among
 * them, and nothing is started ("taken"); any other failure to use the address fails the restore. The address is free only
 * when it is checked: a replacement starting in the moment before the restored server binds it is caught by that
 * server's own bind, which fails.
 * It prints the new process's id. The copy is removed whatever happens.
 */
export const restoreServer = (dir: string, port?: number): string =>
  `d=${shellQuote(dir)}; [ -L "$d/exe" ] || { rm -rf "$d"; echo 'the copy of that server is gone' >&2; exit 1; }; "$d/exe" -e ${shellQuote(RESTORE_LAUNCHER)} ${shellQuote(port && Number.isSafeInteger(port) && port > 0 && port < 65536 ? String(port) : "")} "$d"`;
export const forgetServer = (dir: string): string => `rm -rf ${shellQuote(dir)}`;
export { samePc } from "./ssh-address.ts";
/**
 * The official installer's run on that PC, for one SSH command. Downloaded first, so a failed download is told as one
 * (piped, sh would run an empty script and exit 0), then run with nothing on stdin, on herdr (a herdr plugin that updates
 * itself, as the steps shown say). The exit status is printed rather than returned, so the installer's own last words come
 * back either way.
 *
 * A command run over SSH without a terminal keeps running once the connection ends, as a cancel ends it: so a watcher,
 * started before the download, writes an empty line to the connection every two seconds, and once it cannot (nobody reads there
 * any more) stops the command's whole process group, the download or the installer with it; the command then ends
 * without starting anything more. Right before the installer starts, the command itself writes to the connection too,
 * so one closed since the watcher last wrote starts no installer. It is stopped itself when the installer ends. Empty lines are no
 * output to the reader.
 */
export const installerRun = (release: string, from = installerAt(release)): string =>
  `${REMOTE_PATH}script=$(mktemp) || exit 1; trap 'rm -f "$script"' EXIT; trap 'exit 143' HUP INT TERM; `
  + `( trap '' PIPE; while printf '\\n' 2>/dev/null; do sleep 2 >/dev/null 2>&1; done; kill -TERM 0 ) </dev/null 2>/dev/null & watch=$!; `
  + `if ! curl -fsSL --max-time 120 ${from} -o "$script" || ! head -n 1 "$script" | grep -q '^#!/bin/sh'; then kill "$watch" 2>/dev/null; echo "${DOWNLOAD_FAILED} ${release} from github.com"; printf '\\novis-install-exit=1\\n'; exit 0; fi; `
  // a connection closed since the watcher last wrote ends the command here (SIGPIPE, or the write's error), not the installer
  + `printf '\\n' || exit 141; `
  + `OVIS_REF=${release} OVIS_RUNTIME=herdr OVIS_NO_OPEN=1 sh "$script" </dev/null 2>&1; status=$?; `
  + `kill "$watch" 2>/dev/null; printf '\\novis-install-exit=%s\\n' "$status"`;
/** connects the PC once Ovis answers there (MachineManager.setup, keys only): resolves null once connected, else why not */
export type InstallConnect = (request: { target: SshTarget; name?: string; machine_id?: string; update: boolean; revision?: string; onJob?(job_id: string): void }) => { job_id: string; finished: Promise<string | null>; cancel(): void };
/** `token`: the shown server's descriptor token, so a server that took its pid since is never the one stopped */
export interface InstallPlan { mode: "replace" | "restart"; pid: number; token?: string; socket?: string }
/**
 * The install a PC whose own Ovis refused to update can be offered (Machine.ovis_update how "install"): only on Linux
 * and macOS, where the official installer and this installer's checks run. A Windows PC keeps its plain refusal.
 */
export function installPlanFor(fix: InstallPlan["mode"] | undefined, host: "posix" | "windows", pid: number, target: SshTarget, token?: string, socket?: string): (InstallPlan & { target: SshTarget }) | undefined {
  return fix && host === "posix" ? { mode: fix, pid, ...(token ? { token } : {}), ...(socket ? { socket } : {}), target: { ...target } } : undefined;
}

let release: string | undefined;
export function appRelease(): string {
  return release ??= `v${version}`;
}

class InstallFailed extends Error { constructor(readonly code: PcInstallFailure, message: string) { super(message); } }

interface Facts { os: string; arch: string; tools: Set<string>; writable: boolean; freeKb: number | null; herdrRunning: boolean; launcher: Launcher }
/**
 * How an installed Ovis starts itself there: the herdr plugin (under its id, or the one before the rename), or the
 * user service the installer registers for Ovis on herdr-core; none when it was never installed.
 */
type Launcher = "plugin" | "plugin-legacy" | "systemd" | "launchd" | "none";
const PROBE = REMOTE_PATH + [
  `printf 'os=%s\\narch=%s\\n' "$(uname -s)" "$(uname -m)"`,
  `for tool in curl git tar; do command -v "$tool" >/dev/null 2>&1 && printf 'has=%s\\n' "$tool"; done`,
  `test -w "$HOME" && printf 'writable=1\\n'`,
  `printf 'free_kb=%s\\n' "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 { print $4 }')"`,
  `command -v herdr >/dev/null 2>&1 && printf 'herdr=1\\n'`,
  `herdr status server --json 2>/dev/null </dev/null | grep -q '"running":true' && printf 'herdr_running=1\\n'`,
  `plugins=$(herdr plugin list 2>/dev/null </dev/null); if printf '%s\\n' "$plugins" | grep -q 'devswha.ovis '; then echo launcher=plugin; elif printf '%s\\n' "$plugins" | grep -q 'devswha.herdr-web-ui '; then echo launcher=plugin-legacy; elif systemctl --user cat ovis.service >/dev/null 2>&1; then echo launcher=systemd; elif test -f "$HOME/Library/LaunchAgents/sh.ovis.server.plist"; then echo launcher=launchd; else echo launcher=none; fi`,
  "true",
].join("; ");
function parseProbe(out: string): Facts {
  const lines = out.split("\n");
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? "";
  const free = Number(value("free_kb"));
  return { os: value("os"), arch: value("arch"), tools: new Set(lines.filter((line) => line.startsWith("has=")).map((line) => line.slice(4).trim())),
    writable: lines.includes("writable=1"), freeKb: value("free_kb") !== "" && Number.isFinite(free) ? free : null, herdrRunning: lines.includes("herdr_running=1"),
    launcher: (["plugin", "plugin-legacy", "systemd", "launchd"] as const).find((name) => value("launcher") === name) ?? "none" };
}
function viaLauncher(launcher: Exclude<Launcher, "none">, restart: boolean): string {
  const plugin = launcher === "plugin" ? "devswha.ovis" : "devswha.herdr-web-ui";
  if (launcher === "plugin" || launcher === "plugin-legacy") return `${REMOTE_PATH}${restart ? `herdr plugin action invoke ${plugin}.stop >/dev/null </dev/null; ` : ""}herdr plugin action invoke ${plugin}.start >/dev/null </dev/null`;
  if (launcher === "systemd") return `systemctl --user ${restart ? "restart" : "start"} ovis.service </dev/null`;
  return `launchctl kickstart ${restart ? "-k " : ""}"gui/$(id -u)/sh.ovis.server"`;
}
/** herdr started headless, in a session of its own so it outlives this SSH connection */
const HEADLESS_HERDR = `${REMOTE_PATH}if command -v setsid >/dev/null 2>&1; then setsid nohup herdr server </dev/null >/dev/null 2>&1 & else nohup herdr server </dev/null >/dev/null 2>&1 & fi`;
const OVIS_COMMAND = /\bbun\b.*(server\/(index|managed|supervisor)\.ts|scripts\/plugin\.ts)/;

function sshFailure(error: unknown): InstallFailed {
  const words = (error instanceof Error ? error.message : String(error)).trim().split("\n").filter(Boolean).at(-1) ?? "no answer";
  if (/Host key verification failed|IDENTIFICATION HAS CHANGED|host key .* not known/i.test(words)) {
    return new InstallFailed("ssh_host_key", "That PC's SSH host key is not known here yet, or it changed. Add the PC once with Add PC (SSH), which shows its fingerprint to check, then try again.");
  }
  if (/Permission denied|Too many authentication failures|password|passphrase/i.test(words)) {
    return new InstallFailed("ssh_refused", "That PC did not let this app in with SSH keys, and installing from here never asks for a password. Add this PC's key there (ssh-copy-id), or add the PC once with Add PC (SSH), which can register a key, then try again.");
  }
  return new InstallFailed("ssh_unreachable", `That PC could not be reached over SSH: ${words.slice(0, 300)}`);
}

interface State { public: PcInstallJob; abort: AbortController; ssh?: SshConnection; connect?: { cancel(): void }; finished: Promise<void>; settled?: boolean }

export class PcInstaller {
  private jobs = new Map<string, State>();
  private readonly pollMs: number;
  private readonly startMs: number;
  private readonly stopMs: number;
  constructor(private readonly options: { sshDir: string; connect: InstallConnect; release?: string; onChange?(job: PcInstallJob): void; pollMs?: number; startMs?: number; stopMs?: number;
    /** Settings -> Experimental -> PCs: start a replaced server again. Off (or absent), a server started by hand that an install
     * stopped is never copied or started again: a failed or cancelled replacement leaves it stopped */
    restore?: () => boolean }) {
    this.pollMs = options.pollMs ?? 1000;
    this.startMs = options.startMs ?? 180_000;
    this.stopMs = options.stopMs ?? STOP_WAIT_MS;
  }
  start(request: { target: SshTarget; name?: string; machine_id?: string; plan?: InstallPlan; revision?: string }): PcInstallJob {
    const id = randomUUID();
    const job: PcInstallJob = { id, machine_id: request.machine_id ?? null, target: request.target, mode: request.plan?.mode ?? "install", phase: "connecting",
      step: "Connecting with SSH keys…", error: null, error_code: null, connect_job: null };
    const state: State = { public: job, abort: new AbortController(), finished: Promise.resolve() };
    this.jobs.set(id, state);
    if (this.jobs.size > 40) for (const [key, other] of this.jobs) if (key !== id && other.settled) { this.jobs.delete(key); break; }
    state.finished = this.run(state, request);
    this.options.onChange?.(job);
    return job;
  }
  job(id: string): PcInstallJob | undefined { return this.jobs.get(id)?.public; }
  running(): PcInstallJob[] { return [...this.jobs.values()].filter((state) => !state.settled).map((state) => state.public); }
  async finished(id: string): Promise<void> { await this.jobs.get(id)?.finished; }
  runningFor(machineId: string): PcInstallJob | undefined {
    return [...this.jobs.values()].find((state) => state.public.machine_id === machineId && !state.settled)?.public;
  }
  runningAt(target: SshTarget): PcInstallJob | undefined {
    return [...this.jobs.values()].find((state) => !state.settled && samePc(state.public.target, target))?.public;
  }
  cancel(id: string): void {
    const state = this.jobs.get(id);
    if (!state || ["connected", "failed", "cancelled"].includes(state.public.phase)) return;
    state.abort.abort();
    state.public.phase = "cancelled"; state.public.step = "Cancelled";
    state.ssh?.close();
    state.connect?.cancel();
    this.options.onChange?.(state.public);
  }
  private stopping = false;
  stop(): void { this.stopping = true; for (const id of this.jobs.keys()) this.cancel(id); }

  /**
   * After an install that failed or was cancelled once its server was copied: starts that server again as captureServer
   * copied it, over a new SSH connection (keys only, tried twice: the job's own may be closed or broken), and waits for it
   * to register. Not when the server the stop signal was sent to still runs ("running"), when an Ovis already runs in its
   * place ("replaced"), or when only the copy is to go (`restore` false: "forgotten"). The copy
   * is removed in every case; the PC stays busy until this ends.
   */
  private async startAgain(state: State, request: { target: SshTarget; machine_id?: string }, saved: string, socket: string, port: number | undefined, restore: number | null | false): Promise<string> {
    const job = state.public;
    // this app shutting down opens no SSH connection (an unreachable PC would hold it past the teardown): the copy's own
    // lease removes it there, as it does for a copy this app never came back to
    if (restore === false && this.stopping) return "forgotten";
    job.step = restore === false ? "Removing the copy of that PC's Ovis…" : "Starting that PC's Ovis again as it was (this can take a few minutes, and is not cancelled)…";
    this.options.onChange?.(job);
    let ssh: SshConnection | undefined;
    try {
      for (let tries = 0; ; tries++) {
        ssh = new SshConnection(request.target, this.options.sshDir, request.machine_id ? join(this.options.sshDir, request.machine_id) : undefined);
        try { await ssh.start(); break; } catch (error) { ssh.close(); ssh = undefined; if (tries >= 1) throw error; }
      }
      const at = ssh!;
      const forgotten = async (said: string) => { await at.run(forgetServer(saved)).catch(() => {}); return said; };
      if (restore === false) return await forgotten("forgotten");
      if (restore !== null) {
        for (const until = Date.now() + this.stopMs; await posixHost.alive(at, restore);) {
          if (Date.now() >= until) { if (OVIS_COMMAND.test(await at.run(`ps -o args= -p ${restore} 2>/dev/null || true`))) return await forgotten("running"); break; }
          await Bun.sleep(this.pollMs);
        }
      }
      // the servers registered on this herdr socket, managed or not, on any port, that may still serve it: every one whose pid
      // runs (not a zombie) unless its recorded birth, in its shape, shows another process took that pid since. One whose
      // identity cannot be told (no birth, or one out of its shape) counts as there: fail closed, never a second server (#3385)
      const serving = async (listed?: Awaited<ReturnType<typeof posixHost.descriptors>>): Promise<{ pid: number; birth: unknown; token: string }[]> => {
        const live: { pid: number; birth: unknown; token: string }[] = [];
        for (const d of listed ?? await posixHost.descriptors(at)) {
          if (d.socket_path !== socket || !Number.isSafeInteger(d.pid) || d.pid <= 0) continue;
          const birth = parseBirth(d.birth);
          // its birth now: unread (or of a platform this PC is not) is no proof it is gone, only a birth read and different is
          const now = (await at.run(`${runs(d.pid)} && { ${birthNow(d.pid, birth?.platform)}; echo; } || echo dead`)).trim();
          if (now === "dead") continue;
          if (birth && now !== "" && now !== birth.value) continue;
          live.push({ pid: d.pid, birth: d.birth, token: d.token });
        }
        return live;
      };
      const snapshot = await posixHost.descriptors(at);
      if ((await serving(snapshot)).length > 0) return await forgotten("replaced");
      const listedBefore = new Set(snapshot.filter((d) => d.socket_path === socket).map((d) => d.token));
      if (this.stopping) return await forgotten("forgotten");
      const launched = (await at.run(restoreServer(saved, port))).trim();
      if (launched === "taken") return "replaced";
      // started: once the very process it started (its pid and its birth, as the launcher told them) registers and still
      // runs, never another's, nor one that took its pid after it ended
      const [pidText, launchedBirth] = launched.split(" ");
      const pid = Number(pidText);
      const started = async () => Number.isSafeInteger(pid) && pid > 0 && !!launchedBirth
        && (await serving()).some((d) => d.pid === pid && !listedBefore.has(d.token) && (parseBirth(d.birth)?.value ?? launchedBirth) === launchedBirth)
        && (await at.run(`${bornAs(pid, { platform: "linux", value: launchedBirth })} && echo same || true`)).trim() === "same";
      for (const until = Date.now() + this.startMs; !(await started());) {
        if (Date.now() >= until) return `it did not start within ${Math.round(this.startMs / 1000)} seconds (its output is in ~/.local/state/ovis/restored-server.log there).`;
        await Bun.sleep(this.pollMs);
      }
      return "started";
    } catch (error) {
      return `${(error instanceof Error ? error.message : String(error)).trim().split("\n").at(-1)?.slice(0, 300) ?? "no answer"}.`;
    } finally { ssh?.close(); }
  }
  private async run(state: State, request: { target: SshTarget; name?: string; machine_id?: string; plan?: InstallPlan; revision?: string }): Promise<void> {
    const { public: job, abort } = state;
    const { target, plan } = request;
    const release = this.options.release ?? appRelease();
    const step = (phase: PcInstallJob["phase"], words: string) => {
      if (abort.signal.aborted) throw new Error("Install cancelled");
      job.phase = phase; job.step = words;
      this.options.onChange?.(job);
    };
    const pause = () => new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, this.pollMs);
      abort.signal.addEventListener("abort", done, { once: true });
    });
    let stopped = false;
    const launch = async (command: string) => {
      try { await state.ssh!.run(command); } catch (error) {
        if (abort.signal.aborted) throw error;
        throw new InstallFailed("not_started", `Ovis could not be started on that PC: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      }
    };
    let replaced: "no" | "maybe" | "yes" = "no";
    let saved: string | null = null;
    let savedPort: number | undefined;
    let signalled: number | null = null;
    let socket = "";
    let before = new Set<string>();
    const forget = async () => { if (saved) { const dir = saved; saved = null; await state.ssh?.run(forgetServer(dir)).catch(() => {}); } };
    try {
      // the installer sets Ovis up for herdr's default session; one for a named session is not this app's to guess
      if (target.session) throw new InstallFailed("unsupported", `Installing from here sets Ovis up for herdr's default session only, and this PC is added with the session "${target.session}". Add it without a session to install there.`);
      const ssh = new SshConnection(target, this.options.sshDir, request.machine_id ? join(this.options.sshDir, request.machine_id) : undefined);
      state.ssh = ssh;
      // no challenge: BatchMode, so a PC that wants a password or an unknown host key refuses instead of asking
      try { await ssh.start(); } catch (error) { if (abort.signal.aborted) throw error; throw sshFailure(error); }
      step("checking", "Checking that PC…");
      let facts: Facts;
      try { facts = parseProbe(await ssh.run(PROBE)); } catch (error) { if (abort.signal.aborted) throw error; throw sshFailure(error); }
      if (!["Linux", "Darwin"].includes(facts.os) || !["x86_64", "amd64", "aarch64", "arm64"].includes(facts.arch)) {
        throw new InstallFailed("unsupported", `Installing Ovis from here works on Linux and macOS PCs (x64 or arm64); that PC is ${facts.os ? `${facts.os} ${facts.arch}` : "not one (no POSIX shell answered)"}.`);
      }
      for (const tool of ["curl", "git", "tar"]) if (!facts.tools.has(tool)) throw new InstallFailed("missing_tool", `That PC has no ${tool}, which the installer needs. Install ${tool} there with its package manager, then try again.`);
      if (!facts.writable) throw new InstallFailed("permission", "This SSH account cannot write to its own home folder on that PC, where Ovis installs.");
      if (facts.freeKb !== null && facts.freeKb < MIN_FREE_KB) throw new InstallFailed("disk", `That PC has only ${Math.floor(facts.freeKb / 1024)} MB free in its home folder; installing Ovis needs about 1 GB.`);
      const inspection = await posixHost.inspect(ssh);
      // the planned server is looked for, and checked again up to its stop, on the socket of the registration the plan was
      // made for (a herdr-core server's adapter): on herdr's default one, a live core server would seem gone
      socket = plan?.socket ?? inspection.expectedSocket;
      const listed = inspection.descriptors.filter((d) => d.socket_path === socket);
      const live: BridgeDescriptor[] = [];
      for (const descriptor of listed) if (Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0 && await posixHost.alive(ssh, descriptor.pid)) live.push(descriptor);
      // a new Ovis registers anew, with a token of its own: a pid alone could be an old one's, reused
      before = new Set(inspection.descriptors.filter((d) => d.socket_path === socket || d.socket_path === inspection.expectedSocket).map((d) => d.token));
      // an Ovis already installed there (a plugin, or its service) is started through that, and updated once it answers:
      // the installer would keep it as it is and only start it, whatever release it was asked for
      const installed = facts.launcher !== "none";
      let gone = false;
      if (!plan) {
        if (live.some((d) => d.managed_remote)) throw new InstallFailed("bridge_there", "That PC runs this app's bridge for herdr; update it from its card with Update instead.");
        if (live.length) throw new InstallFailed("ovis_there", "Ovis already runs on that PC. Add it with Add PC, or update it from its card.");
      } else {
        // a herdr-core Ovis started by hand: the official installer's Ovis would come back on herdr's default socket (a
        // herdr Ovis, beside a herdr of its own), not as the Ovis this PC is set to use. Refused before anything is stopped
        const core = socket !== inspection.expectedSocket && isCoreAdapterSocket(socket);
        if (core && plan.mode === "replace" && !installed) throw new InstallFailed("no_launcher", "Ovis on that PC was started by hand; update it there, or start it with its launcher first.");
        // nor through a herdr plugin (one left from before the move, say): its Ovis, or the headless herdr started for it,
        // comes back on herdr's default socket, never as the herdr-core Ovis this PC uses
        if (core && (facts.launcher === "plugin" || facts.launcher === "plugin-legacy")) throw new InstallFailed("no_launcher", "Ovis on that PC is set up as a herdr plugin, not as the herdr-core Ovis this PC uses; update it there.");
        // only the very process the plan was made for, only a server this app did not start, and only while that pid
        // still runs an Ovis server: a pid reused by another program since is never signalled
        const shown = live.find((d) => d.pid === plan.pid && !d.managed_remote && (plan.token === undefined || d.token === plan.token));
        let besideDefault = false;
        if (core) for (const d of inspection.descriptors) if (d.socket_path === inspection.expectedSocket && Number.isSafeInteger(d.pid) && d.pid > 0 && await posixHost.alive(ssh, d.pid)) besideDefault = true;
        gone = !shown && live.length === 0 && !besideDefault;
        // which process it is (when it started, whose it is), read on both sides of its command line: the copy and the stop
        // below go ahead only while it is still this one, never a process that took its pid since
        const identity = shown ? (await ssh.run(processIdentity(plan.pid))).trim() : "";
        const command = shown ? await ssh.run(`ps -o args= -p ${plan.pid} 2>/dev/null || true`) : "";
        const still = shown ? (await ssh.run(processIdentity(plan.pid))).trim() : "";
        // the very server its registration recorded (its birth), not another Ovis that took its pid after it ended
        const born = shown ? (await ssh.run(`${registeredAs(plan.pid, shown)} && echo born || true`)).trim() === "born" : false;
        if (!gone && (!shown || !OVIS_COMMAND.test(command) || !identity || identity !== still)) throw new InstallFailed("changed", CHANGED_WORDS);
        if (!gone && !born) throw new InstallFailed("changed", NOT_REGISTERED_WORDS(plan.pid));
        // a herdr-core server started by hand beside its launcher is never stopped for that launcher's start: nothing
        // shows the launcher starts a herdr-core Ovis at that socket (an ovis.service on herdr's runtime would not), and
        // once the launcher is asked the stopped server is not restored.
        if (core && plan.mode === "replace" && !gone) throw new InstallFailed("no_launcher", "Ovis on that PC was started by hand; update it there, or start it with its launcher first.");
        if (gone && plan.mode === "replace") stopped = true;
        if (plan.mode === "restart" && !installed) throw new InstallFailed("no_launcher", "That PC's Ovis was not installed as a herdr plugin or a user service, so it cannot be restarted from here. Restart it on that PC (Settings → Updates there tells how), then update it.");
        if (plan.mode === "replace" && !gone) {
          step("stopping", `Stopping that PC's Ovis (process ${plan.pid}); herdr and its sessions keep running…`);
          // copied only while starting it again is turned on (experimental): off, it stays stopped if the install then fails
          const copy = this.options.restore?.() === true ? (await ssh.run(captureServer(plan.pid, identity)).catch(() => "error")).trim() : "";
          if (copy === "changed") throw new InstallFailed("changed", CHANGED_WORDS);
          if (copy && copy !== "unfaithful" && !SAVED_SERVER.test(copy)) throw new InstallFailed("not_stopped", "That PC's Ovis could not be copied first, to start it again as it was if the install fails, so nothing was stopped. Try again.");
          saved = SAVED_SERVER.test(copy) ? copy : null;
          savedPort = shown?.port;
          // the stop, in the same command as the check that it is still that process
          signalled = plan.pid;
          // ... and only the very server its registration names (its birth): never another that took the pid after it ended
          if ((await ssh.run(`${shown ? registeredAs(plan.pid, shown) : "false"} && ${sameProcess(plan.pid, identity)} && kill -TERM ${plan.pid} && echo stopping || echo changed`)).trim() !== "stopping") { signalled = null; throw new InstallFailed("changed", CHANGED_WORDS); }
          for (const until = Date.now() + this.stopMs; await posixHost.alive(ssh, plan.pid);) {
            if (Date.now() >= until) throw new InstallFailed("not_stopped", `That PC's Ovis (process ${plan.pid}) did not stop within ${Math.round(this.stopMs / 1000)} seconds, so nothing was installed.`);
            await pause();
            if (abort.signal.aborted) throw new Error("Install cancelled");
          }
          stopped = true;
        }
      }
      let update = job.mode === "restart";
      if (facts.launcher !== "none") {
        step("starting", job.mode === "restart" ? "Restarting that PC's Ovis through its own launcher…" : "Starting the Ovis already installed on that PC…");
        // a plugin's actions need a herdr server: without one, herdr is started headless and starts the plugin itself
        const plugin = facts.launcher === "plugin" || facts.launcher === "plugin-legacy";
        if (plugin && !facts.herdrRunning) { if (stopped) replaced = "maybe"; await launch(HEADLESS_HERDR); }
        else { if (stopped) replaced = "maybe"; await launch(viaLauncher(facts.launcher, job.mode === "restart")); }
        if (stopped) replaced = "yes";
        // the launcher restarts what it runs: a planned process it did not run (started by hand beside it) is still
        // there, and a second Ovis would serve the same socket, so nothing is connected
        // a planned server already gone is not waited for: its pid may run something else by now (after a reboot)
        if (plan?.mode === "restart" && !gone) {
          for (const until = Date.now() + this.stopMs; await posixHost.alive(ssh, plan.pid);) {
            if (Date.now() >= until) {
              // the launcher started an Ovis of its own beside the planned one: only that new one (a token not seen
              // before, an Ovis server's command line) is stopped again, so one Ovis serves the socket, as before.
              for (const extra of (await posixHost.descriptors(ssh)).filter((d) => (d.socket_path === socket || d.socket_path === inspection.expectedSocket) && !d.managed_remote && !before.has(d.token) && Number.isSafeInteger(d.pid) && d.pid > 0 && d.pid !== plan.pid)) {
                if (OVIS_COMMAND.test(await ssh.run(`ps -o args= -p ${extra.pid} 2>/dev/null || true`))) await ssh.run(`kill -TERM ${extra.pid} 2>/dev/null || true`);
              }
              throw new InstallFailed("not_stopped", `That PC's Ovis (process ${plan.pid}) was not started by its launcher, so restarting the launcher did not restart it; the one the launcher started beside it was stopped again. Stop it on that PC, then update it.`);
            }
            await pause();
            if (abort.signal.aborted) throw new Error("Install cancelled");
          }
        }
        update = true;
      } else {
        step("installing", `Installing Ovis ${release} with its official installer (about a minute)…`);
        if (stopped) replaced = "maybe";
        let out: string;
        try { out = await ssh.run(installerRun(release), undefined, INSTALL_TIMEOUT_MS); } catch (error) { if (abort.signal.aborted) throw error; throw sshFailure(error); }
        const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.at(-1) !== "ovis-install-exit=0") {
          // nothing was started in its place only when the installer never ran (its download failed); one that failed
          // later may have started herdr or its plugin already
          if (lines.some((line) => line.startsWith(DOWNLOAD_FAILED))) replaced = "no";
          const said = lines.filter((line) => !line.startsWith("ovis-install-exit=")).slice(-3).join(" ").slice(0, 500);
          throw new InstallFailed("installer_failed", `The Ovis installer failed on that PC: ${said || "it said nothing"}`);
        }
        if (stopped) replaced = "yes";
        // the plugin starts with herdr: one not running is started headless, which runs the plugin's startup hook
        // (as scripts/fresh-install-docker.ts checks), in a session of its own so it outlives this SSH connection
        if (!facts.herdrRunning) await launch(HEADLESS_HERDR);
      }
      step("starting", "Waiting for Ovis to answer on that PC…");
      for (const until = Date.now() + this.startMs; ;) {
        const answering = (await posixHost.descriptors(ssh)).find((d) => d.socket_path === socket && !d.managed_remote && !before.has(d.token) && Number.isSafeInteger(d.pid) && d.pid > 0);
        if (answering && await posixHost.alive(ssh, answering.pid)) { await forget(); break; }
        if (Date.now() >= until) throw new InstallFailed("not_started", `Ovis is ${job.mode === "restart" ? "restarted" : "installed"} on that PC but did not start within ${Math.round(this.startMs / 1000)} seconds. Check herdr's plugin log there (herdr plugin log list).`);
        await pause();
        if (abort.signal.aborted) throw new Error("Install cancelled");
      }
      ssh.close();
      step("connecting_pc", "Connecting to that PC's Ovis…");
      const connect = this.options.connect({ target, ...(request.name ? { name: request.name } : {}), ...(request.machine_id ? { machine_id: request.machine_id } : {}), ...(request.revision ? { revision: request.revision } : {}), update,
        onJob: (id) => { job.connect_job = id; this.options.onChange?.(job); } });
      state.connect = connect;
      job.connect_job = connect.job_id;
      this.options.onChange?.(job);
      const refused = await connect.finished;
      if (abort.signal.aborted) throw new Error("Install cancelled");
      if (refused) throw new InstallFailed("connect_failed", refused);
      job.phase = "connected"; job.step = "Connected";
    } catch (error) {
      // the server stopped (or signalled) for this install, with nothing installed or launched in its place: started again
      // as it was, before the job ends. Not once the installer ran or the launcher was asked: a start of their own may
      // still be on its way there, and would come up beside it.
      const again = saved ? await this.startAgain(state, request, saved, socket, savedPort, !this.stopping && (stopped || signalled !== null) && replaced === "no" ? signalled : false) : null;
      if (again === "running") stopped = false;
      const restored = again === "started" ? " The Ovis started by hand on that PC was stopped for the install, and has been started again as it was."
        : again === "replaced" ? " The Ovis started by hand on that PC was stopped for the install, and another already runs in its place; it was not started beside it."
        : again && !["running", "forgotten"].includes(again) ? ` The Ovis started by hand on that PC was stopped for the install, and starting it again as it was failed: ${again} Update tries the install again.` : null;
      if (abort.signal.aborted) {
        job.phase = "cancelled"; job.step = "Cancelled";
        if (restored) job.error = `Cancelled.${restored}`;
        else if (stopped) job.error = replaced === "no" && again !== "replaced"
          ? "Cancelled after the Ovis started by hand on that PC was stopped, so none runs there now; Update tries the install again."
          : `Cancelled after the Ovis started by hand on that PC was stopped and another was ${replaced === "yes" ? "installed" : "being installed"} in its place, which may not be running; Update tries again.`;
      }
      else {
        job.phase = "failed"; job.step = "Install failed";
        job.error_code = error instanceof InstallFailed ? error.code : null;
        job.error = (error instanceof Error ? error.message : String(error))
          + (restored ?? (!stopped ? "" : replaced === "yes"
            ? " The Ovis started by hand on that PC was stopped, and the one installed in its place did not connect; Update tries again."
            : replaced === "maybe"
            ? " The Ovis started by hand on that PC was stopped, and another may have been installed in its place; Update tries again."
            : " The Ovis started by hand on that PC was already stopped, so none runs there now; Update tries the install again."));
      }
    } finally {
      state.ssh?.close();
      state.settled = true;
      this.options.onChange?.(job);
    }
  }
}
