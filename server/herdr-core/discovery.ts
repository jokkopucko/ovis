/**
 * Finding herdr-core (`hc`) on this PC, the way the Herdr app does (herdr-app src/core_bin.rs),
 * and whether its core runs, without ever starting one.
 *
 * Every hc command but `--version` starts a core when none runs (`hc connect` and
 * `hc server status` included), which would leave a core and its systemd unit on a PC that only
 * uses herdr's TUI. So a candidate is only ever asked `--version`, and the core counts as running
 * when its socket file is there: nothing connects to it.
 */
import { lstatSync, readFileSync, readlinkSync, statSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { HerdrCoreFacts } from "../../shared/machines.ts";
import { readHerdrConfig } from "../herdr-sidebar.ts";
import { loginPathProbe, loginShell } from "../shell-agent.ts";
import { userHome } from "../user-home.ts";

type Env = Record<string, string | undefined>;

export interface FoundHc {
  /** the executable, as found */
  bin: string;
  /** what its `--version` says after `hc ` */
  version: string;
}

export interface FindHcOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** the PATH the user's login shell sets up, or null; the default asks `$SHELL -lc` */
  loginShellPath?: () => Promise<string | null>;
  /** where hc gets installed; the default is usualHcDirs */
  usualDirs?: readonly string[];
  /** how long one --version may take; PROBE_TIMEOUT_MS unset */
  timeoutMs?: number;
  /** getfacl's path, or null when it is not installed; the default looks in /usr/bin and /bin */
  getfacl?: string | null;
  /** told each candidate the trust check refuses, and why */
  onRefused?: (bin: string, reason: string) => void;
}

/** a slow or interactive shell profile, or a hanging binary, must not hold the server up */
const PROBE_TIMEOUT_MS = 3_000;
/** how long output is still read after the probe exits: what it left behind holding stdout is not waited on */
const EXIT_GRACE_MS = 500;
/** a version line, and a PATH, are short: anything longer is not what was asked for */
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/**
 * The first herdr-core found, or null. Where it looks, in order: OVIS_HC_BIN; the usual install
 * places; this process's PATH; then the user's login shell's PATH (a server started by herdr's
 * plugin or a service may not carry it). In each folder `herdr-core` comes before `hc`, the name
 * the core's installer gives it, and a candidate counts only when `--version` exits 0 and says
 * `hc …`: some window managers ship an unrelated `hc`.
 *
 * Asking `--version` runs the candidate as this user, so on Linux and macOS only one that no
 * other account can have put or changed there is run (ownedByUser); an OVIS_HC_BIN path is the
 * user's own choice and is run as named. Windows has no mode bits to read: there the usual places
 * (under the user's profile) coming before the PATH is the only protection.
 */
export async function findHc(options: FindHcOptions = {}): Promise<FoundHc | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? userHome(env, platform);
  const exe = platform === "win32" ? ".exe" : "";
  const names = (dir: string) => [join(dir, `herdr-core${exe}`), join(dir, `hc${exe}`)];
  const dirsOn = (path: string | undefined) => (path ?? "").split(platform === "win32" ? ";" : delimiter).filter((dir) => dir !== "");
  const seen = new Set<string>();
  const harmless = platform === "win32" ? null : harmlessGroups(platform);
  // one look reads each ACL once
  const acl = aclReader({ platform, ...(options.getfacl !== undefined ? { getfacl: options.getfacl } : {}) });
  // what the candidate runs by name (`#!/usr/bin/env python3`, a wrapper's commands) comes only from
  // PATH folders that pass the same check, resolved (a wrapper may change folder first); none passing
  // gives the system's own, never an empty PATH, which a shell searches the working folder for. This
  // covers the --version probe only: `hc connect` keeps the user's PATH on purpose, since a core it
  // starts hands that environment to every pane (connection.ts)
  let probeEnv: Env | undefined;
  const checkedDirs = (dirs: string[]) => dirs.map((dir) => resolve(dir)).filter((dir) => ownedByUser(dir, harmless!, true, acl));
  const probing = () => probeEnv ??= harmless === null ? env : {
    ...env,
    PATH: [...new Set(checkedDirs(dirsOn(env["PATH"])))].join(delimiter) || checkedDirs(SYSTEM_PATH).join(delimiter) || "/nonexistent",
  };
  const pick = async (candidates: string[], named = false): Promise<FoundHc | null> => {
    for (const candidate of candidates) {
      // absolute: a terminal attach runs it from another folder (server/core/terminal-process.ts),
      // and what is run is what was checked, whatever folder the server is in
      const bin = resolve(candidate);
      if (seen.has(bin)) continue;
      seen.add(bin);
      if (!isFile(bin)) continue;
      const refused = named || harmless === null ? null : trustRefusal(bin, harmless, false, acl);
      if (refused !== null) {
        options.onRefused?.(bin, refused);
        continue;
      }
      const version = await hcVersion(bin, probing(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
      if (version !== null) return { bin, version };
    }
    return null;
  };
  // a bare name is looked up on the PATH, as a shell would run it, and checked like anything found
  // there: one refused leaves the next PATH folder to look in (Windows checks nothing, so its first)
  const configured = env["OVIS_HC_BIN"];
  const bare = configured !== undefined && !/[\\/]/.test(configured);
  const named = !configured ? [] : !bare ? [configured]
    : harmless === null ? [Bun.which(configured, { PATH: env["PATH"] ?? "" }) ?? configured]
    : dirsOn(env["PATH"]).map((dir) => join(dir, configured));
  return await pick(named, !bare)
    ?? await pick((options.usualDirs ?? usualHcDirs(home, platform, env)).flatMap(names))
    ?? await pick(dirsOn(env["PATH"]).flatMap(names))
    ?? await pick(dirsOn(await (options.loginShellPath ?? (() => loginShellPath(env, platform)))() ?? "").flatMap(names));
}

/** the PATH a probe gets when no PATH folder passes the check */
const SYSTEM_PATH = ["/usr/bin", "/bin"];

/** the most links followed to reach one candidate, as the kernel allows (Linux's MAXSYMLINKS) */
const MAX_LINKS = 40;

/**
 * Whether nothing at `path` (absolute) can be another account's doing (POSIX): every folder, link
 * and the file itself that reaching it walks through, from `/`, belongs to this user or root, so
 * the check and the run that follows see the same file. The file and the folder holding it are
 * writable by nobody else; a folder on the way may be when it is sticky (/tmp), where nobody can
 * rename or replace an entry they do not own. Group write counts as nobody else's only for a
 * group `harmless` names, and no ACL may grant write either (`acl`, aclReader). With
 * `asFolder`, the path is a folder held to the same rule as a file's.
 */
export function ownedByUser(path: string, harmless: (gid: number, path: string) => boolean, asFolder = false, acl: AclReader = aclReader()): boolean {
  return trustRefusal(path, harmless, asFolder, acl) === null;
}

/** why ownedByUser refuses `path`, naming the entry and the rule it fails; null when it does not */
export function trustRefusal(path: string, harmless: (gid: number, path: string) => boolean, asFolder = false, acl: AclReader = aclReader()): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return "no user id to check against";
  const owned = (stats: Stats, at: string) => stats.uid === uid || stats.uid === 0 ? null : `${at} is owned by uid ${stats.uid}, not you or root`;
  const writable = (stats: Stats, at: string): string | null => {
    if ((stats.mode & 0o002) !== 0) return `${at} is writable by everyone`;
    const group = (stats.mode & 0o020) !== 0;
    if (group && !harmless(stats.gid, at)) {
      return `${at} is group-writable by gid ${stats.gid}, not trusted as your own private group (it has other members, or /etc/nsswitch.conf reads accounts from more than files and systemd, as sss does)`;
    }
    // on Linux a named ACL entry can write only through the group bits (they show its mask); a
    // macOS ACL never shows in the mode
    if (!group && !acl.darwin) return null;
    return acl.grantsWrite(at, uid, harmless) ? `an ACL on ${at} may let another account write it` : null;
  };
  const parts = (path: string) => path.split("/").filter((part) => part !== "" && part !== ".");
  try {
    // `folder` is always a real path whose every folder has been checked on the way to it
    let folder = "/";
    let here = statSync("/");
    const rest = parts(path);
    let links = 0;
    while (true) {
      if (!here.isDirectory()) return `${folder} is not a folder`;
      const folderOwner = owned(here, folder);
      if (folderOwner !== null) return folderOwner;
      const name = rest.shift();
      if (name === undefined) return asFolder ? writable(here, folder) : `${path} is a folder`;
      // a sticky folder on the way: nobody may rename or replace what is not theirs in it
      const open = writable(here, folder);
      if (open !== null && (here.mode & 0o1000) === 0) return open;
      if (name === "..") {
        folder = dirname(folder);
        here = statSync(folder);
        continue;
      }
      const entry = join(folder, name);
      const stats = lstatSync(entry);
      const entryOwner = owned(stats, entry);
      if (entryOwner !== null) return entryOwner;
      if (stats.isSymbolicLink()) {
        if (++links > MAX_LINKS) return `${path} goes through more than ${MAX_LINKS} links`;
        const target = readlinkSync(entry);
        rest.unshift(...parts(target));
        if (target.startsWith("/")) {
          folder = "/";
          here = statSync("/");
        }
        continue;
      }
      if (rest.length === 0 && !stats.isDirectory()) {
        if (asFolder || !stats.isFile()) return `${entry} is not a regular file`;
        return writable(stats, entry) ?? open;
      }
      folder = entry;
      here = stats;
    }
  } catch (error) {
    return `${path} could not be checked (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
  }
}

/** where Homebrew keeps what it installs, its folders group-writable by admin */
const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local"];

/**
 * The groups whose write access lets in nobody else: the user's own private group (with umask 002,
 * as on Debian and Ubuntu, ~/.local/bin is group-writable), and on macOS admin inside Homebrew's
 * prefixes, which Homebrew leaves group-writable by admin: whoever can change hc there can change
 * the brew the user runs already.
 */
export function harmlessGroups(platform: NodeJS.Platform = process.platform, own: () => number | null = ownGroup): (gid: number, path: string) => boolean {
  let gid: number | null | undefined;
  return (group, path) => {
    if (platform === "darwin" && group === 80) return HOMEBREW_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    gid ??= own();
    return group === gid;
  };
}

function ownGroup(): number | null {
  const read = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  try {
    return privateGroup(userInfo().username, process.getgid?.() ?? -1, read("/etc/group") ?? "", read("/etc/passwd") ?? "", read("/etc/nsswitch.conf") ?? "");
  } catch {
    return null;
  }
}

/**
 * The account sources whose every account /etc lists. Anything else may add members unseen: sss,
 * ldap, nis, winbind, and compat, whose `+` lines pull in NIS accounts.
 */
const LOCAL_SOURCES = new Set(["files", "systemd"]);

/**
 * `gid` when it is `user`'s private group, from /etc/group and /etc/passwd: named after them, with
 * no other member, and no other account's primary group; else null. Only when nsswitch.conf has a
 * passwd and a group line and every account line takes local files alone: a group a directory
 * service could add a member to (a missing line means the C library's default, which may) is not
 * taken on trust, nor one whose passwd could not be read.
 */
export function privateGroup(user: string, gid: number, groups: string, passwd: string, nsswitch: string): number | null {
  const databases = new Set<string>();
  for (const line of nsswitch.split("\n")) {
    const match = /^\s*(passwd|group|initgroups)\s*:(.*)$/.exec(line);
    if (!match) continue;
    databases.add(match[1]!);
    if (match[2]!.split(/\s+/).some((source) => source !== "" && !source.startsWith("[") && !LOCAL_SOURCES.has(source))) return null;
  }
  if (!databases.has("passwd") || !databases.has("group")) return null;
  if (passwd.trim() === "") return null;
  const lines = (text: string) => text.split("\n").map((line) => line.split(":")).filter((fields) => fields.length >= 4 && /^\d+$/.test(fields[2]!.trim()));
  const named = lines(groups).filter((fields) => Number(fields[2]) === gid);
  if (named.length === 0) return null;
  for (const [name, , , members] of named) {
    if (name !== user || members!.split(",").some((member) => member.trim() !== "" && member.trim() !== user)) return null;
  }
  const others = passwd.split("\n").map((line) => line.split(":")).some((fields) => fields.length >= 4 && fields[0] !== user && /^\d+$/.test(fields[3]!.trim()) && Number(fields[3]) === gid);
  return others ? null : gid;
}

/** how long reading one ACL may take: one that does not answer counts as granting */
const ACL_READ_TIMEOUT_MS = 2_000;
/** how long a macOS ACL read stands: the walk from `/` asks the same folders on every look */
const MAC_ACL_TTL_MS = 60_000;
const macAcls = new Map<string, { at: number; grants: boolean }>();

export interface AclReader {
  darwin: boolean;
  /** whether an ACL lets anybody else write `path` (a file or folder, never a link) */
  grantsWrite(path: string, uid: number, harmless: (gid: number, path: string) => boolean): boolean;
}

/**
 * Reads ACLs, each path once. On Linux (only asked when the group bits allow write) from
 * `getfacl`: a named user other than this one or root, or a named group or the owning group
 * `harmless` does not name, holding write that the mask lets through (linuxAclGrantsWrite). Without
 * getfacl, `ls -ld` says whether the path has an ACL at all: with none the group bits are the
 * owning group's own, already checked; one that cannot be read counts as granting. On macOS from
 * `ls -lde` (macAclGrantsWrite). Whatever cannot be read, or does not answer in time, grants.
 */
export function aclReader(options: { platform?: NodeJS.Platform; getfacl?: string | null } = {}): AclReader {
  const darwin = (options.platform ?? process.platform) === "darwin";
  const cache = new Map<string, boolean>();
  let getfacl = options.getfacl;
  const read = (argv: string[]) => {
    try {
      const run = Bun.spawnSync(argv, { env: { LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: ACL_READ_TIMEOUT_MS });
      return run.exitCode === 0 ? run.stdout.toString() : null;
    } catch {
      return null;
    }
  };
  const grants = (path: string, uid: number, harmless: (gid: number, path: string) => boolean): boolean => {
    if (darwin) {
      const kept = macAcls.get(path);
      if (kept !== undefined && Date.now() - kept.at < MAC_ACL_TTL_MS) return kept.grants;
      const listing = read(["/bin/ls", "-lde", "--", path]);
      const answer = listing === null || macAclGrantsWrite(listing, userInfo().username);
      macAcls.set(path, { at: Date.now(), grants: answer });
      return answer;
    }
    if (getfacl === undefined) getfacl = Bun.which("getfacl", { PATH: SYSTEM_PATH.join(delimiter) });
    if (getfacl === null) {
      const listing = read(["/bin/ls", "-ld", "--", path]);
      return listing === null || /^\S{10}\+/.test(listing);
    }
    const acl = read([getfacl, "-cpn", "--", path]);
    if (acl === null) return true;
    let owningGroup: number;
    try { owningGroup = statSync(path).gid; } catch { return true; }
    return linuxAclGrantsWrite(acl, uid, (gid) => harmless(gid, path), owningGroup);
  };
  return {
    darwin,
    grantsWrite(path, uid, harmless) {
      let answer = cache.get(path);
      if (answer === undefined) cache.set(path, answer = grants(path, uid, harmless));
      return answer;
    },
  };
}

/** a Linux `getfacl -cpn` listing: whether an entry the mask lets through gives anybody else write */
export function linuxAclGrantsWrite(acl: string, uid: number, harmless: (gid: number) => boolean, owningGroup: number): boolean {
  const entries = acl.split("\n").map((line) => line.replace(/#.*$/, "").trim()).filter((line) => line !== "").map((line) => line.split(":"));
  if (entries.some((fields) => fields.length !== 3)) return true;
  const mask = entries.find(([kind]) => kind === "mask");
  if (mask !== undefined && !mask[2]!.includes("w")) return false;
  return entries.some(([kind, who, perms]) => {
    if (!perms!.includes("w")) return false;
    if (kind === "user") return who !== "" && Number(who) !== uid && Number(who) !== 0;
    if (kind === "group") return !harmless(who === "" ? owningGroup : Number(who));
    return kind === "other";
  });
}

/** what a macOS ACL entry may allow that lets its holder change what is there */
const MAC_WRITE_RIGHTS = new Set(["write", "append", "add_file", "add_subdirectory", "delete", "delete_child", "writeattr", "writeextattr", "writesecurity", "chown"]);

/**
 * A macOS `ls -lde` listing: whether an ACL entry may let anybody but `user` write, add, delete or
 * take over. A principal may hold spaces (`group:Domain Users`); an entry not read as
 * `<principal> [inherited] allow|deny <rights>` that names a write right counts as allowing it.
 */
export function macAclGrantsWrite(listing: string, user: string): boolean {
  return listing.split("\n").some((line) => {
    const body = /^\s*\d+:\s+(.*?)\s*$/.exec(line)?.[1];
    if (body === undefined) return false;
    const entry = /^(.+?)\s+(?:inherited\s+)?(allow|deny)\s+([A-Za-z_,]+)$/.exec(body);
    if (entry === null) return body.split(/[\s,:]+/).some((word) => MAC_WRITE_RIGHTS.has(word));
    return entry[2] === "allow" && entry[1] !== `user:${user}` && entry[3]!.split(",").some((right) => MAC_WRITE_RIGHTS.has(right));
  });
}

/** Where herdr-core gets installed: its own installer (~/.local/bin), Homebrew, mise, Nix, cargo. */
export function usualHcDirs(home: string, platform: NodeJS.Platform = process.platform, env: Env = process.env): string[] {
  if (platform === "win32") {
    return [join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "Programs", "herdr-core"), join(home, ".cargo", "bin")];
  }
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".nix-profile", "bin"),
    "/run/current-system/sw/bin",
    join(home, ".cargo", "bin"),
  ];
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** `0.1.17` when `bin --version` exits 0 and its output starts `hc 0.1.17`; null for anything else. The only hc command run here. */
export async function hcVersion(bin: string, env: Env, timeoutMs: number): Promise<string | null> {
  const text = await probe([bin, "--version"], env, timeoutMs);
  const match = text === null ? null : /^hc (\d+\.\d+\.\d+[0-9A-Za-z.+-]*)(?:\s|$)/.exec(text);
  return match ? match[1]! : null;
}

/** the login shell's PATH through the probe Agents uses too (server/shell-agent.ts): marked, bounded, its group killed */
async function loginShellPath(env: Env, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === "win32") return null;
  const shell = loginShell(env);
  if (shell === null) return null;
  return (await loginPathProbe({ shell, env, timeoutMs: PROBE_TIMEOUT_MS })(new AbortController().signal)).path;
}

/**
 * stdout of a command that exits 0 within `timeoutMs` and says no more than the limit, else null.
 * It runs in a process group of its own, killed once the answer is in: something it left behind
 * holding stdout is read for at most EXIT_GRACE_MS after the exit, never waited on.
 */
async function probe(argv: string[], env: Env, timeoutMs: number): Promise<string | null> {
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env, windowsHide: true, detached: process.platform !== "win32" });
  } catch {
    return null;
  }
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number) => new Promise<void>((resolve) => { timers.push(setTimeout(resolve, ms)); });
  const drained = (async (): Promise<boolean> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      size += value.length;
      if (size > PROBE_OUTPUT_LIMIT) return false;
      chunks.push(value);
    }
  })().catch(() => false);
  // one deadline for the whole probe: the output, then the exit
  const deadline = after(timeoutMs).then(() => "late" as const);
  try {
    const outcome = await Promise.race([
      drained.then((complete) => complete ? "read" as const : "too-much" as const),
      child.exited.then(() => after(EXIT_GRACE_MS)).then(() => "exited" as const),
      deadline,
    ]);
    if (outcome === "too-much" || outcome === "late") return null;
    const code = await Promise.race([child.exited, deadline.then(() => null)]);
    return code === 0 ? new TextDecoder().decode(Buffer.concat(chunks)) : null;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group has ended */ }
    }
    child.kill("SIGKILL");
    void reader.cancel().catch(() => {});
  }
}

export interface CoreSocketOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** `/run/user/<uid>` when that folder exists, else null: hc's runtime dir without XDG_RUNTIME_DIR */
  userRuntimeDir?: string | null;
}

export interface CoreSocket {
  session: string;
  path: string;
  /** the socket file is there; it is never connected to, so a core that died may leave one */
  running: boolean;
}

/**
 * Where the core of this environment listens, as hc works it out (herdr-core paths.rs): HC_SOCKET,
 * else `socket` in its config.toml, else `<session>.sock` in herdr-core under the runtime dir
 * (XDG_RUNTIME_DIR, else /run/user/<uid>), else beside the state in
 * `$XDG_STATE_HOME/herdr-core/<session>/` (macOS). The session is HC_SESSION, else `default`.
 */
export function coreSocket(options: CoreSocketOptions = {}): CoreSocket {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? userHome(env, platform);
  const session = env["HC_SESSION"]?.trim() || "default";
  const config = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "herdr-core", "config.toml");
  const state = join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "herdr-core", session);
  const path = env["HC_SOCKET"] || configuredSocket(config) || defaultSocket();
  return { session, path, running: exists(path) };

  function defaultSocket(): string {
    if (platform === "win32") return `\\\\.\\pipe\\herdr-core-${(env["USERNAME"] ?? "").replace(/[^A-Za-z0-9]/g, "")}-${session}.sock`;
    const run = runtimeDir(env, options);
    return run === null ? join(state, `${session}.sock`) : join(run, "herdr-core", `${session}.sock`);
  }
}

function runtimeDir(env: Env, options: CoreSocketOptions): string | null {
  if (env["XDG_RUNTIME_DIR"]) return env["XDG_RUNTIME_DIR"];
  if (options.userRuntimeDir !== undefined) return options.userRuntimeDir;
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const dir = `/run/user/${uid}`;
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/** `socket` in hc's config.toml, when it sets one */
function configuredSocket(config: string): string | null {
  // read as herdr's own config is: a regular file of a config's size, never a FIFO a health poll would block on
  const parsed = readHerdrConfig(config);
  const socket = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["socket"] : undefined;
  return typeof socket === "string" && socket !== "" ? socket : null;
}

/** hc's Windows pipe answers a stat with EBUSY while each of its instances is taken (live-seen with a core running): it is there */
function exists(path: string): boolean {
  try { statSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EBUSY"; }
}

/** how long one look for hc stands: it runs a login shell and each candidate's --version */
const FIND_TTL_MS = 5 * 60_000;
let found: { at: number; hc: FoundHc | null } | null = null;
let finding: Promise<FoundHc | null> | null = null;

/**
 * Looks for hc again for Settings (one look at a time) and keeps the answer for herdrCoreFacts.
 * It never runs the login shell: its profile could run any command, `hc connect` included, from a
 * health request on a PC that never chose herdr-core. Only startRuntime looks there (findHc).
 */
export function discoverHc(options: Omit<FindHcOptions, "loginShellPath"> = {}): Promise<FoundHc | null> {
  finding ??= findHc({ ...options, loginShellPath: async () => null }).then((hc) => {
    found = { at: Date.now(), hc };
    return hc;
  }).finally(() => { finding = null; });
  return finding;
}

/** Looks for hc afresh once any look under way has ended: one started before an install would miss it. */
export async function rediscoverHc(options: Omit<FindHcOptions, "loginShellPath"> = {}): Promise<FoundHc | null> {
  await finding?.catch(() => null);
  return discoverHc(options);
}

/**
 * What this PC has of herdr-core, for Settings: never waits. Undefined until the first look for hc
 * has ended; a look older than FIND_TTL_MS starts another, and this answer stays meanwhile.
 */
export function herdrCoreFacts(): HerdrCoreFacts | undefined {
  if (finding === null && (found === null || Date.now() - found.at > FIND_TTL_MS)) void discoverHc();
  if (found === null) return undefined;
  const socket = coreSocket();
  // hc takes only a plain folder name for a session; anything else is not told, so no path can be
  return { version: found.hc?.version ?? null, session: plainSession(socket.session), running: socket.running };
}

export function plainSession(session: string): string | null {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(session) && session !== "." && session !== ".." ? session : null;
}
