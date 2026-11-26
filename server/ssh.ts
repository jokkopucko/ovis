import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rmdir, stat } from "node:fs/promises";
import { connect as tcpConnect, createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { FileSink, Subprocess } from "bun";
import type { SshTarget } from "../shared/machines.ts";
import { entryCommand } from "./entries.ts";
import { shellQuote } from "./machine-security.ts";
import { chunksOf } from "./remote-bundle.ts";

export interface StreamInput { path: string; onProgress?(done: number): void; onUploaded?(): void }

const WINDOWS = process.platform === "win32";
/** Unix sockets (including OpenSSH's temporary control path) must fit even with a long TMPDIR. */
const SSH_DIR_ROOT = WINDOWS ? tmpdir() : "/tmp";
const SSH_DIR_PREFIX = "herdr-ssh-";

/**
 * Removes the empty connection folders an earlier server left behind: a connection that was
 * created and never started or closed, before the folder came only with start(). Thousands of
 * them fill a tmpfs /tmp's inodes. Only an empty folder older than `maxAgeMs` goes: a started
 * connection's folder holds its sockets, and rmdir refuses a folder that is not empty.
 */
export async function sweepSshDirs(root = SSH_DIR_ROOT, maxAgeMs = 60 * 60_000, now = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[];
  try { names = await readdir(root); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(SSH_DIR_PREFIX)) continue;
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
      if (process.getuid && info.uid !== process.getuid()) continue;
      await rmdir(path);
      removed++;
    } catch {} // not empty, gone already, or not ours: left as it is
  }
  return removed;
}

/**
 * A local path as the value of an ssh option. OpenSSH splits option values like a shell and
 * reads `\` as an escape, so a Windows path goes with forward slashes (which Windows accepts).
 */
function sshPath(path: string): string { return WINDOWS ? path.replaceAll("\\", "/") : path; }

export interface SshClient {
  ssh: string; sftp: string; keygen: string;
  /** Git for Windows' build, found where its installer put it, which does not read Windows' ssh-agent service */
  git?: true;
}

/**
 * A line ssh -v writes that is not ssh's word on what went wrong: its debug lines, and the few it writes
 * unprefixed (its version banner, "Authenticated to", and the transfer totals it writes at exit).
 */
export function sshVerboseLine(line: string): boolean {
  return /^(?:debug\d: |OpenSSH_|Authenticated to |Transferred: sent |Bytes per second: )/u.test(line);
}

/**
 * Whether this ssh says on a pipe that a direct-mode forward is bound. Windows' own OpenSSH writes none
 * of its -v lines to a pipe (checked on Windows 11 with 9.5p2: a file or a console gets them, a pipe
 * nothing), so with it forward() takes the first listener on the port, as before. Git for Windows' ssh,
 * and OpenSSH elsewhere, say it on a pipe. Wrong here, every Windows connect without Git waits 25 s.
 */
export function forwardSaysReady(client: { git?: boolean }, platform: NodeJS.Platform = process.platform): boolean {
  return client.git === true || platform !== "win32";
}

/**
 * Which OpenSSH runs. `OVIS_SSH` names an ssh, with the sftp and ssh-keygen beside it. Windows
 * otherwise takes Git for Windows' build (installing Ovis there requires Git): the OpenSSH that
 * ships with Windows, started by a server that has no console, never exits once a remote command
 * wrote anything, so every connection hung until its timeout (Win32-OpenSSH#1427, #1470).
 * Git is looked for only where its installer puts it, never through PATH: the ssh runs with the
 * account's keys, and a folder on PATH may be one anybody can write to.
 */
export function sshClient({ env = process.env, platform = process.platform, exists = existsSync, which = (command: string) => Bun.which(command), registry = gitInstallPath }: {
  env?: Record<string, string | undefined>; platform?: NodeJS.Platform; exists?: (path: string) => boolean; which?: (command: string) => string | null; registry?: () => string | null;
} = {}): SshClient {
  const path = platform === "win32" ? win32 : posix;
  const plain: SshClient = { ssh: "ssh", sftp: "sftp", keygen: "ssh-keygen" };
  const beside = (ssh: string): SshClient => {
    const extension = path.extname(ssh) || (platform === "win32" ? ".exe" : "");
    const sibling = (name: string, fallback: string) => {
      const file = path.join(path.dirname(ssh), name + extension);
      return path.dirname(ssh) !== "." && exists(file) ? file : fallback;
    };
    return { ssh, sftp: sibling("sftp", plain.sftp), keygen: sibling("ssh-keygen", plain.keygen) };
  };
  // a value pasted with its quotes; it is a path, never evaluated by a shell
  const override = env["OVIS_SSH"]?.trim().replace(/^"(.*)"$/, "$1");
  if (override) return beside(override.includes("/") || override.includes("\\") ? override : which(override) ?? override);
  if (platform !== "win32") return plain;
  // a machine-wide install (the registry and Program Files take an administrator to change),
  // then one inside this account's own profile, which only the account itself can write
  const roots: string[] = [];
  const installed = registry();
  if (installed) roots.push(installed);
  for (const base of [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"] && win32.join(env["LOCALAPPDATA"], "Programs")]) if (base) roots.push(win32.join(base, "Git"));
  if (env["USERPROFILE"]) roots.push(win32.join(env["USERPROFILE"], "scoop", "apps", "git", "current"));
  for (const root of roots) {
    const ssh = win32.join(root, "usr", "bin", "ssh.exe");
    if (exists(ssh)) return { ...beside(ssh), git: true };
  }
  return plain;
}

/**
 * What a refused connection adds to ssh's own words. Git for Windows' ssh does not read Windows'
 * ssh-agent service, so a key only that service holds is the likely thing missing. Any other
 * ssh, Windows' own included (which reads that service), gets nothing added.
 */
export function refusalHint(client: SshClient, stderr: string): string {
  return client.git && /Permission denied/.test(stderr)
    ? "\nGit for Windows' ssh, which this server runs on Windows, does not read Windows' ssh-agent service. Use a key file (~/.ssh/id_ed25519, or IdentityFile in ~/.ssh/config) or a password."
    : "";
}

let gitInstall: string | null | undefined;
/** Git for Windows' machine-wide install folder, as its installer recorded it, read once. */
function gitInstallPath(): string | null {
  if (gitInstall !== undefined) return gitInstall;
  gitInstall = null;
  if (!WINDOWS) return gitInstall;
  // reg.exe by its full path: a reg.exe earlier on PATH must not answer
  const reg = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");
  const result = Bun.spawnSync([reg, "query", "HKLM\\SOFTWARE\\GitForWindows", "/v", "InstallPath"], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 3000 });
  gitInstall = /InstallPath\s+REG_SZ\s+(.+)/.exec(result.stdout?.toString() ?? "")?.[1]?.trim() || null;
  return gitInstall;
}

/**
 * Strict checking refused a host it has no key for. A changed key says something else
 * ("REMOTE HOST IDENTIFICATION HAS CHANGED") and never reaches the fingerprint question.
 */
const UNKNOWN_HOST = /No \S+ host key is known for /;
const CONFIG_FORWARD = /^(localforward|remoteforward|dynamicforward) /m;
/** bytes askSocket reads of an answer before refusing it: a recovery socket's answers are a few hundred */
const SOCKET_ANSWER_MAX = 65_536;
export const SOCKET_SSH_TOO_OLD = "Adding a PC to your account over SSH from Windows needs OpenSSH 9.4 or newer on this PC. Update Git for Windows (or OpenSSH), then try again.";

/**
 * Whether the ssh that printed `version` (`ssh -V`) reaches a Unix socket with `-W`: OpenSSH does from 9.4 on (its release
 * notes); before that it reads the path as a host name and its port.
 */
export function stdioSocketForward(version: string): boolean {
  const match = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 9 || (major === 9 && minor >= 4);
}

function listening(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = tcpConnect({ host: "127.0.0.1", port });
  const done = (open: boolean) => { socket.destroy(); resolve(open); };
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  socket.setTimeout(1000, () => done(false));
  return promise;
}

/**
 * What ssh said last, for the setup dialog: some messages ask the user to act while ssh keeps
 * waiting (Tailscale SSH's browser check URL), and the exit error is too late for those.
 * Control characters go (a terminal's colours and cursor moves mean nothing in a dialog).
 */
export function recentSshOutput(text: string, maxLines = 8, maxBytes = 2048): string {
  const lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "").split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxBytes ? tail.slice(-maxBytes) : tail;
}

/**
 * What PowerShell 5 says on stderr over a pipe: its error records serialized as CLIXML, the
 * text in `<S S="Error">` elements with `_x000D__x000A_` for newlines. The words, nothing else.
 */
export function decodeClixml(stderr: string): string {
  const lines: string[] = [];
  for (const [, text] of stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)) {
    const decoded = text!.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    lines.push(decoded);
  }
  const message = lines.join("").replace(/\r\n/g, "\n").trim();
  return message || stderr.replace(/#< CLIXML[\s\S]*/, "").trim() || "PowerShell failed";
}

/**
 * One SSH destination for a setup or a connected PC.
 *
 * Multiplexed (Linux, macOS): one OpenSSH master; every command, upload and forward goes over
 * its control socket, so a password typed once serves them all.
 *
 * Direct (Windows, whichever ssh runs; Windows' own OpenSSH has no connection sharing:
 * `getsockname failed: Not a socket`):
 * every command is its own ssh process, a long-lived `ssh -N` stands in for the master, and each
 * forward is its own `ssh -N -L`. An ssh-agent signs for all of them (Git for Windows' ssh reads
 * `SSH_AUTH_SOCK`, not Windows' agent service); a password or passphrase the
 * user typed while connecting is kept in memory for this connection only and answered to the
 * same prompt again, never stored. A host key is learned without authenticating and confirmed
 * in the dialog before any connection that authenticates, because a `.cmd` askpass helper only
 * receives a prompt's first line, not the fingerprint below it.
 */
export class SshConnection {
  private dir = "";
  private get control(): string { return join(this.dir, "control"); }
  private client = sshClient();
  private master: Subprocess | null = null;
  private children = new Set<Subprocess>();
  private tunnels = new Set<Subprocess>();
  private pending = new Set<(error: Error) => void>();
  private broken = false;
  private closed = false;
  private started = false;
  private askSockets = new Set<Socket>();
  private askServer = createServer();
  private askPath = "";
  private askHelper = "";
  /** only a helper started by this connection's ssh knows it */
  private askToken = randomBytes(32).toString("hex");
  /** direct mode: answers typed during start(), kept once start() authenticated with them */
  private typed = new Map<string, string>();
  private answers = new Map<string, string>();
  private stderr = "";
  usedSecret = false;
  /**
   * Public keys only (the user's config, key files and agent; a key's passphrase may still be asked): no password or
   * keyboard-interactive login. Set before start() for a connection that vouches for an account add (machines.ts).
   */
  publicKeyOnly = false;
  onExit: (() => void) | null = null;
  onOutput: ((text: string) => void) | null = null;

  constructor(readonly target: SshTarget, readonly stateDir: string, readonly keyPath?: string, readonly keyOnly = false, readonly multiplexed = !WINDOWS) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  private makeDir(): string {
    if (!this.dir) {
      this.dir = mkdtempSync(join(SSH_DIR_ROOT, SSH_DIR_PREFIX));
      chmodSync(this.dir, 0o700);
    }
    return this.dir;
  }
  /**
   * The options ssh and sftp share; the port flag differs (`-p` is sftp's preserve-times).
   * A forward of ours needs `clearForwardings` off: ClearAllForwardings drops a `-L` too.
   */
  private options(clearForwardings = true): string[] {
    const args = ["-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
    if (clearForwardings) args.unshift("-o", "ClearAllForwardings=yes");
    if (this.keyOnly) args.push("-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none");
    if (this.publicKeyOnly) args.push("-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no");
    // the account's own `ControlMaster auto` would make every connection fail on Windows
    if (!this.multiplexed) args.push("-o", "ControlMaster=no", "-o", "ControlPath=none");
    if (this.target.port) args.push("-o", `Port=${this.target.port}`);
    if (this.target.identity_file) args.push("-i", this.target.identity_file.replace(/^~[\\/]/, homedir() + "/"));
    if (this.keyPath && existsSync(this.keyPath)) args.push("-i", this.keyPath);
    return args;
  }
  private base(): string[] {
    return [this.client.ssh, "-S", this.control, ...this.options()];
  }
  private knownHosts(): string { return join(this.stateDir, "known_hosts"); }
  private knownHostsOption(): string {
    return `UserKnownHostsFile=${[this.knownHosts(), join(homedir(), ".ssh/known_hosts"), join(homedir(), ".ssh/known_hosts2")].map((path) => shellQuote(sshPath(path))).join(" ")}`;
  }
  /**
   * A direct-mode ssh. It always checks the host strictly; it may answer a prompt only when
   * start() kept an answer for it, and the helper then refuses any prompt it has none for.
   * Keyboard-interactive is off: its prompt is the server's own text, and ssh on Windows hands a
   * prompt to the `.cmd` helper on a command line that cmd parses, quoting `"` only as `\"`, so
   * a `"` and `&` in it would run a command here before the helper sees it. Password and
   * passphrase prompts are built by ssh itself from this PC's config.
   */
  private direct(batch: "yes" | "no" = this.answers.size ? "no" : "yes", clearForwardings = true): string[] {
    return [this.client.ssh, ...this.options(clearForwardings), "-o", `BatchMode=${batch}`, "-o", "KbdInteractiveAuthentication=no", "-o", "StrictHostKeyChecking=yes", "-o", this.knownHostsOption()];
  }
  private askEnv(): Record<string, string | undefined> {
    return this.askHelper ? { ...process.env, SSH_ASKPASS: this.askHelper, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "herdr:0", HERDR_ASKPASS_SOCKET: this.askPath, HERDR_ASKPASS_TOKEN: this.askToken } : { ...process.env };
  }
  private trusted(token: unknown): boolean {
    if (typeof token !== "string" || token.length !== this.askToken.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(this.askToken));
  }
  async start(challenge?: (prompt: string, hostKey: boolean) => Promise<string>): Promise<void> {
    if (this.closed) throw new Error("Connection cancelled");
    this.makeDir();
    // a named pipe on Windows, where node:net cannot listen on a file path
    this.askPath = WINDOWS ? `\\\\.\\pipe\\herdr-askpass-${randomBytes(16).toString("hex")}` : join(this.dir, "ask");
    this.askServer.on("connection", (socket) => {
      this.askSockets.add(socket);
      socket.on("close", () => this.askSockets.delete(socket));
      let data = "";
      socket.on("data", async (chunk) => {
        data += chunk;
        if (data.length > 16384) { socket.destroy(); return; }
        if (!data.includes("\n")) return;
        socket.pause();
        try {
          const request = JSON.parse(data) as { token?: unknown; prompt?: unknown };
          // anyone on this PC may open a named pipe; only our own helper has the token
          if (!this.trusted(request.token)) throw new Error("Unknown askpass client");
          const prompt = String(request.prompt);
          const hostKey = /fingerprint|continue connecting/i.test(prompt);
          let answer = hostKey ? undefined : this.answers.get(prompt);
          if (answer === undefined) {
            // once connected, nothing asks the user again: a new prompt is an auth that failed
            if (this.started) throw new Error("SSH asked again after connecting");
            if (!challenge) throw new Error("SSH authentication required; reconnect from PC settings");
            if (!hostKey) this.usedSecret = true;
            answer = await challenge(prompt, hostKey);
            if (!hostKey && !this.multiplexed) this.typed.set(prompt, answer);
          }
          if (!this.closed) socket.end(JSON.stringify({ answer }) + "\n");
        } catch { socket.destroy(); }
      });
    });
    const listen = Promise.withResolvers<void>();
    this.askServer.once("error", listen.reject);
    this.askServer.listen(this.askPath, listen.resolve);
    await listen.promise;
    if (!WINDOWS) chmodSync(this.askPath, 0o600);
    const [runtime, script] = entryCommand("askpass");
    if (WINDOWS) {
      // cmd expands %…% even inside quotes; a literal percent sign is %%
      this.askHelper = join(this.dir, "askpass.cmd");
      const quoted = (path: string) => `"${path.replaceAll("%", "%%")}"`;
      writeFileSync(this.askHelper, `@${quoted(runtime)} ${quoted(script)} %*\r\n`);
    } else {
      this.askHelper = join(this.dir, "askpass");
      writeFileSync(this.askHelper, `#!/bin/sh\nexec ${shellQuote(runtime)} ${shellQuote(script)} "$@"\n`, { mode: 0o700 });
    }
    if (!existsSync(this.knownHosts())) writeFileSync(this.knownHosts(), "", { mode: 0o600 });
    if (this.multiplexed) await this.startMaster(challenge);
    else await this.startDirect(challenge);
    this.started = true;
    this.onOutput = null;
  }
  private async startMaster(challenge?: (prompt: string, hostKey: boolean) => Promise<string>): Promise<void> {
    const args = [...this.base(), "-M", "-N", "-T", "-o", "ControlPersist=no", "-o", "ExitOnForwardFailure=yes", "-o", `BatchMode=${challenge ? "no" : "yes"}`, "-o", `StrictHostKeyChecking=${challenge ? "ask" : "yes"}`, "-o", this.knownHostsOption(), this.target.destination];
    const proc = this.master = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: this.askEnv() });
    void (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; this.stderr = (this.stderr + decoder.decode(value, { stream: true })).slice(-8192); this.onOutput?.(recentSshOutput(this.stderr)); } } finally { reader.releaseLock(); }
    })();
    void proc.exited.then(() => { if (!this.closed) this.onExit?.(); });
    const until = Date.now() + (challenge ? 300_000 : 25_000);
    while (!existsSync(this.control)) {
      if (this.closed) throw new Error("Connection cancelled");
      if (proc.exitCode !== null || Date.now() > until) throw new Error(this.stderr.trim() || "SSH connection timed out");
      await Bun.sleep(100);
    }
  }
  private async startDirect(challenge?: (prompt: string, hostKey: boolean) => Promise<string>): Promise<void> {
    const until = Date.now() + (challenge ? 300_000 : 25_000);
    // `exit` ends the session in sh, cmd and PowerShell alike, whichever the account's shell is
    let probe = await this.attempt([...this.direct(challenge ? "no" : "yes"), "-T", this.target.destination, "exit"], until);
    if (probe.code !== 0 && challenge && UNKNOWN_HOST.test(probe.stderr)) {
      await this.learnHostKey(challenge);
      probe = await this.attempt([...this.direct("no"), "-T", this.target.destination, "exit"], until);
    }
    if (probe.code !== 0) {
      throw new Error((probe.stderr.trim() || "SSH connection failed") + refusalHint(this.client, probe.stderr));
    }
    for (const [prompt, answer] of this.typed) this.answers.set(prompt, answer);
    this.typed.clear();
    const keepalive = this.master = Bun.spawn([...this.direct(), "-N", "-T", this.target.destination], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: this.askEnv() });
    void keepalive.exited.then(() => { if (!this.closed) this.onExit?.(); });
  }
  private async attempt(args: string[], until: number, report = true): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: this.askEnv() });
    this.children.add(proc);
    const timer = setTimeout(() => proc.kill(), Math.max(0, until - Date.now()));
    let stderr = "";
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stderr = (stderr + decoder.decode(value, { stream: true })).slice(-8192);
          if (report) this.onOutput?.(recentSshOutput(stderr));
        }
      } finally { reader.releaseLock(); }
      const code = await proc.exited;
      if (this.closed) throw new Error("Connection cancelled");
      if (code !== 0 && Date.now() >= until) throw new Error(stderr.trim() || "SSH connection timed out");
      return { code, stderr };
    } finally { clearTimeout(timer); this.children.delete(proc); }
  }
  /**
   * The server's key, read by a connection that offers no authentication at all, shown in the
   * dialog, and trusted only on a yes. The connections after it check strictly against it, so
   * a server that shows another key to them is refused, not asked about.
   */
  private async learnHostKey(challenge: (prompt: string, hostKey: boolean) => Promise<string>): Promise<void> {
    const file = join(this.dir, "learned_hosts");
    rmSync(file, { force: true });
    const seen = await this.attempt([this.client.ssh, ...this.options(), "-o", "BatchMode=yes", "-o", "PreferredAuthentications=none", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${shellQuote(sshPath(file))}`, "-o", `GlobalKnownHostsFile=${WINDOWS ? "NUL" : "/dev/null"}`, "-T", this.target.destination, "exit"], Date.now() + 25_000, false);
    const learned = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (!learned) throw new Error(seen.stderr.trim() || "Could not read the server's host key");
    const fingerprints = (await this.exec([this.client.keygen, "-l", "-f", file])).split(/\r?\n/).flatMap((line) => {
      const match = /^\d+ (\S+) .*\((\S+)\)$/.exec(line.trim());
      return match ? [`${match[2]} key fingerprint is ${match[1]}.`] : [];
    });
    if (!fingerprints.length) throw new Error("Could not read the server's host key");
    const host = this.target.port ? `[${this.target.destination}]:${this.target.port}` : this.target.destination;
    const answer = await challenge(`The authenticity of host '${host}' can't be established.\n${fingerprints.join("\n")}\nAre you sure you want to continue connecting (yes/no)? `, true);
    if (this.closed) throw new Error("Connection cancelled");
    if (answer !== "yes") throw new Error("Host key verification failed.");
    appendFileSync(this.knownHosts(), learned + "\n", { mode: 0o600 });
  }
  /** `maxOutput`: bytes its stdout and its stderr may each send; past that the command is stopped and fails */
  async run(script: string, input?: Uint8Array | StreamInput, timeout = 90_000, maxOutput?: number): Promise<string> {
    if (this.closed) throw new Error("SSH connection closed");
    // BatchMode prevents an expired master from unexpectedly opening a new password prompt.
    return this.exec([...(this.multiplexed ? [...this.base(), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"] : this.direct()), "-T", this.target.destination, "sh -c " + shellQuote(script)], input, timeout, maxOutput);
  }
  /**
   * A script for a Windows host. OpenSSH there hands the command to cmd or PowerShell,
   * whichever is the account's default shell, and the two quote differently; a base64
   * `-EncodedCommand` passes through both untouched. Output comes back as UTF-8 with Unix
   * newlines whatever the host's code page (Korean Windows answers in CP949 otherwise).
   */
  async runPowerShell(script: string, input?: Uint8Array | StreamInput, timeout = 90_000): Promise<string> {
    if (this.closed) throw new Error("SSH connection closed");
    // no progress bars: over a pipe PowerShell 5 serializes them to stderr as CLIXML
    const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64");
    try {
      const out = await this.exec([...(this.multiplexed ? [...this.base(), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"] : this.direct()), "-T", this.target.destination, `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`], input, timeout);
      return out.replace(/\r\n/g, "\n");
    } catch (error) {
      if (error instanceof Error && error.message.includes("#< CLIXML")) throw new Error(decodeClixml(error.message), { cause: error });
      throw error;
    }
  }
  /**
   * A file to a Windows host, by sftp over the same connection. Its stdin cannot carry it:
   * PowerShell's console host owns a redirected stdin (5.1 never reads it for the script, 7
   * recodes it as text), and the account's default shell decides which of the two is in the
   * way. sftp is a subsystem, so neither is. The remote path is a Windows one; Windows
   * sftp-server spells a drive-absolute path `/C:/Users/...` (a bare `C:/...` is relative).
   */
  async upload(localPath: string, remotePath: string, timeout = 30 * 60_000): Promise<void> {
    if (this.closed) throw new Error("SSH connection closed");
    if (/[\r\n"]/.test(localPath + remotePath)) throw new Error("Invalid characters for a remote path");
    const remote = "/" + remotePath.replaceAll("\\", "/");
    const put = new TextEncoder().encode(`put "${sshPath(localPath)}" "${remote}"\n`);
    // sftp's -b adds BatchMode=yes after the options before it, and ssh keeps the first value
    const options = this.multiplexed
      ? [...this.options(), "-o", `ControlPath=${this.control}`, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]
      : this.direct().slice(1);
    // sftp starts its own build's ssh unless told which
    await this.exec([this.client.sftp, ...(this.client.ssh === "ssh" ? [] : ["-S", this.client.ssh]), ...options, "-b", "-", this.target.destination], put, timeout);
  }
  async forward(port: number, remotePort: number): Promise<void> {
    if (this.closed) throw new Error("SSH connection closed");
    if (this.multiplexed) {
      // Mux commands read SSH config too: even a master with ClearAllForwardings
      // would accept those extra tunnels here. -O uses only our existing control
      // socket, so no host config is needed; ClearAllForwardings would erase our -L.
      await this.exec([this.client.ssh, "-F", "none", "-S", this.control, "-O", "forward", "-L", `127.0.0.1:${port}:127.0.0.1:${remotePort}`, this.target.destination]);
      return;
    }
    // Our -L needs ClearAllForwardings off, which would also open the forwards the account's
    // SSH config names for this host. Those are refused rather than opened on the user's behalf.
    if (CONFIG_FORWARD.test(await this.exec([this.client.ssh, "-G", ...this.options(false), this.target.destination]))) {
      throw new Error(`The SSH config for ${this.target.destination} sets LocalForward, RemoteForward or DynamicForward, which the web UI on Windows cannot switch off. Use a host alias without them.`);
    }
    const told = forwardSaysReady(this.client);
    const proc = Bun.spawn([...this.direct(undefined, false), ...(told ? ["-v"] : []), "-N", "-T", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:127.0.0.1:${remotePort}`, this.target.destination], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: this.askEnv() });
    this.tunnels.add(proc);
    void proc.exited.then(() => {
      this.tunnels.delete(proc);
      if (this.closed) return;
      this.broken = true;
      this.onExit?.();
    });
    if (!told) {
      const stderr = new Response(proc.stderr).text();
      // ssh opens the local port only once it authenticated and the forward stands
      const until = Date.now() + 25_000;
      while (!(await listening(port))) {
        if (this.closed) throw new Error("Connection cancelled");
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error((await stderr).trim() || "SSH port forward failed");
        if (Date.now() > until) { proc.kill(); throw new Error("SSH port forward timed out"); }
        await Bun.sleep(100);
      }
      return;
    }
    // Something listening on the port proves nothing: another process on this PC may have taken it
    // after it was found free, before ssh's own bind, and a request sent there would hand it the
    // bridge's token. ssh enters its session only once its forwards are bound, and with
    // ExitOnForwardFailure it exits instead when the port is taken. (Its "Local forwarding
    // listening" comes before the bind.) Only this ssh's own "Entering interactive session" counts:
    // the one that follows its line naming this forward. A ProxyJump's ssh gets -v too, shares this
    // stderr and enters its own session once it is in the jump host, before this ssh has even
    // authenticated, and names no forward. A LogVerbose config puts a source location after the
    // level, so the messages are looked for anywhere in a debug line. The rest of stderr is drained
    // and only ssh's own words, not the debug lines, are kept for an error.
    const own = `Local connections to 127.0.0.1:${port} forwarded to remote address 127.0.0.1:${remotePort}`;
    const ready = Promise.withResolvers<void>();
    void (async () => {
      const decoder = new TextDecoder();
      let partial = "";
      let said = "";
      let named = false;
      for await (const chunk of proc.stderr) {
        const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
        partial = lines.pop()!.slice(-4096);
        for (const line of lines) {
          if (!sshVerboseLine(line)) said = (said + line.replace(/\r$/, "") + "\n").slice(-8192);
          else if (line.includes(own)) named = true;
          else if (named && line.includes("Entering interactive session.")) ready.resolve();
        }
      }
      ready.reject(new Error(said.trim() || "SSH port forward failed"));
    })().catch((error: unknown) => ready.reject(error));
    let timedOut = false;
    // a ProxyCommand child that outlives the kill can hold stderr open: neither the timeout nor a close waits for it
    const timer = setTimeout(() => { timedOut = true; proc.kill(); ready.reject(new Error("SSH port forward timed out")); }, 25_000);
    this.pending.add(ready.reject);
    try { await ready.promise; }
    catch (error) {
      if (this.closed) throw new Error("Connection cancelled");
      if (timedOut) throw new Error("SSH port forward timed out");
      throw error;
    } finally { clearTimeout(timer); this.pending.delete(ready.reject); }
  }
  /**
   * A Unix socket on the PC (its owner's recovery socket) reached at a socket in this connection's own folder, which only
   * this account may enter. Multiplexed connections only (Linux, macOS); askSocket serves the others.
   */
  async forwardSocket(remotePath: string): Promise<string> {
    if (this.closed) throw new Error("SSH connection closed");
    if (!this.multiplexed) throw new Error("Forwarding a socket needs a multiplexed SSH connection");
    if (/[\s:]/.test(remotePath) || !remotePath.startsWith("/")) throw new Error("Invalid remote socket path");
    const local = join(this.makeDir(), `fwd-${randomBytes(8).toString("hex")}.sock`);
    this.socketForwards.set(local, remotePath);
    try { await this.exec([this.client.ssh, "-F", "none", "-S", this.control, "-O", "forward", "-L", `${local}:${remotePath}`, this.target.destination]); }
    catch (error) { await this.closeSocketForward(local); throw error; }
    return local;
  }
  private socketForwards = new Map<string, string>();
  /**
   * One line to a Unix socket on the PC (its owner's recovery socket) and the first line it answers, for a connection with
   * no master to forward it (Windows): on an ssh's own stdin and stdout (`ssh -W`), so nothing listens on this PC for it
   * and no other process here can reach that socket. The socket's side stays open until it answered.
   */
  async askSocket(remotePath: string, line: string): Promise<string> {
    if (this.closed) throw new Error("SSH connection closed");
    if (this.multiplexed) throw new Error("A multiplexed connection reaches a socket with forwardSocket");
    if (/[\s:]/.test(remotePath) || !remotePath.startsWith("/")) throw new Error("Invalid remote socket path");
    if (line.includes("\n")) throw new Error("A socket request is one line");
    // `ssh -V` says its version on stderr
    const version = Bun.spawn([this.client.ssh, "-V"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [shown, also] = await Promise.all([new Response(version.stderr).text(), new Response(version.stdout).text(), version.exited]);
    // close() may have run while the version was asked: it ends only the children it saw
    if (this.closed) throw new Error("SSH connection closed");
    if (!stdioSocketForward(shown + also)) throw new Error(SOCKET_SSH_TOO_OLD);
    const proc = Bun.spawn([...this.direct(), "-W", remotePath, this.target.destination], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: this.askEnv() });
    this.children.add(proc);
    let said = "";
    const stderr = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) said = (said + decoder.decode(chunk, { stream: true })).slice(-4096);
    })().catch(() => {});
    try {
      // an ssh that could not reach the socket may have closed its input already: its own words below say why
      try { proc.stdin.write(`${line}\n`); await proc.stdin.flush(); } catch {}
      const decoder = new TextDecoder();
      let answer = "";
      for await (const chunk of proc.stdout) {
        answer += decoder.decode(chunk, { stream: true });
        const end = answer.indexOf("\n");
        if ((end < 0 ? answer.length : end) > SOCKET_ANSWER_MAX) throw new Error(`The PC sent more than ${SOCKET_ANSWER_MAX} bytes on its socket; it was not read`);
        if (end >= 0) return answer.slice(0, end);
      }
      if (this.closed) throw new Error("Connection cancelled");
      await stderr;
      throw new Error(said.trim() || "The PC answered nothing on its socket");
    } finally {
      this.children.delete(proc);
      proc.kill();
    }
  }
  /** Ends a forward forwardSocket opened: the master stops listening there, and the local socket file goes. */
  async closeSocketForward(local: string): Promise<void> {
    const remote = this.socketForwards.get(local);
    if (remote === undefined) return;
    this.socketForwards.delete(local);
    try { if (!this.closed && this.master !== null && this.master.exitCode === null) await this.exec([this.client.ssh, "-F", "none", "-S", this.control, "-O", "cancel", "-L", `${local}:${remote}`, this.target.destination]); }
    finally { rmSync(local, { force: true }); }
  }
  private async exec(args: string[], input?: Uint8Array | StreamInput, timeout = 30_000, maxOutput?: number): Promise<string> {
    const stream = input !== undefined && !(input instanceof Uint8Array) ? input : undefined;
    const proc = Bun.spawn(args, { stdin: stream ? "pipe" : input ? new Blob([new Uint8Array(input as Uint8Array)]) : "ignore", stdout: "pipe", stderr: "pipe", env: this.askEnv() });
    this.children.add(proc);
    const timer = setTimeout(() => proc.kill(), timeout);
    // a file goes over in chunks, each written once ssh has taken the last one, so what was
    // written tracks what was sent to within ssh's own buffer
    const feed = stream ? (async () => {
      const sink = proc.stdin as FileSink;
      let done = 0;
      try {
        for await (const chunk of chunksOf(Bun.file(stream.path).stream())) {
          await sink.write(chunk); await sink.flush();
          done += chunk.length; stream.onProgress?.(done);
        }
      } finally { try { await sink.end(); } catch {} }
      stream.onUploaded?.();
    })().then(() => null, (error: unknown) => error) : Promise.resolve(null);
    try {
      // a capped stream is read only up to its cap: past it the command is stopped, and nothing it sent is taken
      const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
        if (maxOutput === undefined) return new Response(stream).text();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > maxOutput) { proc.kill(); throw new Error(`The PC sent more output than expected (over ${maxOutput} bytes); it was not read`); }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString("utf8");
      };
      const [out, err, code, fed] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited, feed]);
      if (this.closed) throw new Error("Connection cancelled");
      if (code !== 0) throw new Error(err.trim().slice(-4096) || `SSH command failed (${code})`);
      if (fed) throw fed instanceof Error ? fed : new Error(String(fed));
      return out;
    } finally { clearTimeout(timer); this.children.delete(proc); }
  }
  /** whether the master connection still stands: false once ssh exited (the PC went away), was killed (Bun then sets only signalCode) or was closed; in direct mode also once a forward ended */
  connected(): boolean { return !this.closed && !this.broken && this.master !== null && this.master.exitCode === null && this.master.signalCode === null; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.master?.kill();
    for (const child of this.children) child.kill();
    for (const tunnel of this.tunnels) tunnel.kill();
    for (const reject of this.pending) reject(new Error("Connection cancelled"));
    for (const socket of this.askSockets) socket.destroy();
    this.askServer.close();
    this.typed.clear(); this.answers.clear();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
