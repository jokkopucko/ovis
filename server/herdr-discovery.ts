import { existsSync, lstatSync, opendirSync, readFileSync, statSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalize, posix } from "node:path";
import { aclReader, harmlessGroups, trustRefusal } from "./herdr-core/discovery.ts";
import { herdrAcceptsConnection } from "./herdr/client.ts";
import type { FoundHerdrSession } from "../shared/machines.ts";

export interface HerdrDiscoveryHost {
  home: string;
  xdg?: string;
  procRoot?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  probe?(socket: string): Promise<boolean>;
}
interface DiscoveryScope { dirs: Set<string>; paths: Set<string>; uid: number | undefined; temps: string[] }
const MAX_CANDIDATES = 256;
const PROBE_TIMEOUT_MS = 1000;
const currentHost = (): HerdrDiscoveryHost => ({ home: process.env.HOME || homedir(), xdg: process.env.XDG_CONFIG_HOME, procRoot: "/proc", platform: process.platform, uid: process.getuid?.() });

/** The isolated herdr sessions this app's own tests and checks start (scripts/test-herdr.ts, scripts/check.ts, the demo). */
export function testHerdrSession(name: string): boolean {
  return /^(?:ovis-test(?:-[a-zA-Z0-9_-]*)?|ovis-demo|check-[0-9a-f]{6}(?:-\d+)?)$/.test(name);
}

/**
 * A path in a throwaway folder: under the account's cache folder, or in a temp folder (the usual ones, or `temps`, as
 * a TMPDIR) the account's home is not inside. Test runs and trial copies start herdr there (a mkdtemp
 * XDG_CONFIG_HOME); their sessions are never the user's to connect to.
 */
export function throwawayPath(path: string, home: string, ...temps: (string | undefined)[]): boolean {
  // herdr sockets are POSIX paths, whatever this app's own platform
  const inside = (dir: string, at: string) => posix.normalize(at + "/").startsWith(posix.normalize(dir + "/"));
  const temp = [...temps, "/tmp", "/var/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/dev/shm"]
    // a temp folder holding the home, or its .config, would be everything: such a TMPDIR is no throwaway folder
    .filter((dir): dir is string => !!dir?.startsWith("/") && !inside(dir, home) && !inside(dir, posix.join(home, ".config")));
  return [posix.join(home, ".cache"), ...temp].some((dir) => inside(dir, path));
}

/** A socket's session name: the folder it has in a herdr root's sessions/ (one of `roots`, or a literal herdr/). */
function sessionOf(path: string, roots: Iterable<string> = []): string | undefined {
  for (const root of roots) if (path.startsWith(root + "/sessions/")) return /^\/sessions\/([a-zA-Z0-9_-]{1,64})\/herdr\.sock$/.exec(path.slice(root.length))?.[1];
  return /\/herdr\/sessions\/([a-zA-Z0-9_-]{1,64})\/herdr\.sock$/.exec(path)?.[1];
}

function processSocket(args: string[], home: string, xdg?: string): string | null {
  if (!args[0]?.split("/").pop()?.startsWith("herdr")) return null;
  const tail = args.slice(1);
  let session: string | undefined;
  const at = tail.indexOf("--session");
  if (at >= 0) { session = tail[at + 1]; tail.splice(at, 2); }
  if (tail[0] !== "server" || session !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(session)) return null;
  const root = xdg?.startsWith("/") ? xdg : join(home, ".config");
  return session ? join(root, "herdr/sessions", session, "herdr.sock") : join(root, "herdr/herdr.sock");
}

async function discoveryScope(host: HerdrDiscoveryHost): Promise<DiscoveryScope> {
  const scope: DiscoveryScope = { dirs: new Set(), paths: new Set(), uid: host.uid ?? process.getuid?.(), temps: [tmpdir()] };
  const add = (path: string) => {
    const session = sessionOf(path, scope.dirs);
    if (scope.paths.size < MAX_CANDIDATES && !(session && testHerdrSession(session)) && !throwawayPath(path, host.home, ...scope.temps) && existsSync(path)) scope.paths.add(path);
  };
  const allowRoot = (root: string | undefined) => {
    if (!root?.startsWith("/")) return;
    // Canonicalize the trusted directory, never a candidate socket or a session symlink.
    try { scope.dirs.add(realpathSync(join(root, "herdr"))); } catch {}
  };
  allowRoot(join(host.home, ".config")); allowRoot(host.xdg);
  // this account's herdr servers, read first: the TMPDIR of any of them stays a throwaway folder for every root the scan
  // reaches, whatever order the processes are listed in
  const servers: { path: string; xdg?: string }[] = [];
  const server = (args: string[], home: string | undefined, xdg?: string, tmp?: string) => {
    if (home !== host.home) return;
    const path = processSocket(args, home, xdg);
    if (!path) return;
    if (tmp?.startsWith("/") && !scope.temps.includes(tmp)) scope.temps.push(tmp);
    servers.push({ path, xdg });
  };
  if (host.platform === "linux" && host.procRoot) {
    try {
      const directory = opendirSync(host.procRoot);
      try {
        for (let entry; (entry = directory.readSync()) !== null;) {
          if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
          const proc = join(host.procRoot, entry.name);
          try {
            if (statSync(proc).uid !== scope.uid) continue;
            const args = readFileSync(join(proc, "cmdline"), "utf8").split("\0").filter(Boolean);
            const env = Object.fromEntries(readFileSync(join(proc, "environ"), "utf8").split("\0").filter(Boolean).map((item) => {
              const at = item.indexOf("="); return at < 0 ? [item, ""] : [item.slice(0, at), item.slice(at + 1)];
            }));
            server(args, env.HOME, env.XDG_CONFIG_HOME, env.TMPDIR);
          } catch { /* the process exited or its environment is private */ }
        }
      } finally { directory.closeSync(); }
    } catch { /* /proc is optional; the configured roots still work */ }
  } else if (host.platform === "darwin") {
    const ps = Bun.spawn(["ps", "eww", "-U", String(scope.uid), "-o", "command="], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS });
    const text = await new Response(ps.stdout).text();
    if (await ps.exited === 0) for (const line of text.split("\n")) {
      // ps separates environment assignments with spaces; a value ends at the next assignment, not its first space.
      const env = Object.fromEntries([...line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/g)].map((match) => [match[1], match[2]]));
      server(line.trim().split(/\s+/), env.HOME, env.XDG_CONFIG_HOME, env.TMPDIR);
    }
  }
  for (const { path, xdg } of servers) {
    if (xdg?.startsWith("/") && throwawayPath(xdg, host.home, ...scope.temps)) continue;
    allowRoot(xdg?.startsWith("/") ? xdg : join(host.home, ".config"));
    add(path);
  }
  for (const dir of scope.dirs) {
    add(join(dir, "herdr.sock"));
    try {
      const directory = opendirSync(join(dir, "sessions"));
      try {
        for (let entry; scope.paths.size < MAX_CANDIDATES && (entry = directory.readSync()) !== null;) {
          if (entry.isDirectory()) add(join(dir, "sessions", entry.name, "herdr.sock"));
        }
      } finally { directory.closeSync(); }
    } catch {}
  }
  // Roots and their named sessions cover the contract; /proc/net/unix cannot authorize another directory.
  return scope;
}

export async function chosenHerdrSocketStatus(path: string, host: HerdrDiscoveryHost = currentHost(), scope?: DiscoveryScope): Promise<"usable" | "gone" | "refused"> {
  if (!validHerdrSocket(path)) return "refused";
  const allowed = scope ?? await discoveryScope(host);
  try {
    // lstat proves the socket itself is no link; its folder carries the real-path check: Bun on macOS cannot resolve a socket (EOPNOTSUPP).
    const socket = lstatSync(path);
    if (!socket.isSocket() || socket.uid !== allowed.uid || realpathSync(dirname(path)) !== dirname(path)) return "refused";
    if (![...allowed.dirs].some((dir) => path.startsWith(dir + "/"))) return "refused";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "gone" : "refused";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answering = await Promise.race([
      (host.probe ?? herdrAcceptsConnection)(path),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); }),
    ]);
    return answering ? "usable" : "gone";
  } catch { return "gone"; }
  finally { clearTimeout(timer); }
}

/**
 * Where a socket a server keeps for its life may be (pinnedHerdrSocketStatus): trusted herdr folders, this account,
 * and `walk`, why another account could rename, replace or write something on the way from `/` to a folder or in
 * it (null: nobody could).
 */
export interface HerdrSocketPlace { dirs: string[]; uid: number | undefined; walk(folder: string): string | null }

/** How long a pinned place keeps its ACL answers and its private group: as long as macOS's ACL reads are kept. */
const PLACE_ACL_AGE_MS = 60_000;

/**
 * A place's walk: trustRefusal (each folder this account's or root's, none writable by anybody else but a sticky
 * one on the way, as /tmp). A check of where a path points proves nothing about the connection after it while
 * another account may rename a folder above it. One ACL reader and one private-group answer per place, read again
 * after PLACE_ACL_AGE_MS: getfacl, which runs for each group-writable folder, would otherwise run before every
 * connection. Modes, owners and groups are read on every walk, so a folder made unsafe by chmod or chown is
 * refused at once. Only an ACL answer waits out its age, and only this account or root can change the ACL of a
 * folder the walk accepts: every such folder is theirs.
 */
function placeWalk(): (folder: string) => string | null {
  let harmless = profileGroups(), acl = aclReader(), since = Date.now();
  return (folder) => {
    if (Date.now() - since >= PLACE_ACL_AGE_MS) { harmless = profileGroups(); acl = aclReader(); since = Date.now(); }
    return trustRefusal(folder, harmless, true, acl);
  };
}

/**
 * The groups whose write access lets nobody else into the machine profile's own folders (its herdr sockets' and its
 * state folder's walks): this account's provably private group alone. harmlessGroups' Homebrew rule, which trusts
 * macOS's admin group under /opt/homebrew and /usr/local for the hc found there, is left out: a second admin
 * account could write there. Its rule without the darwin case, whatever the platform; `own` stands in for the
 * account's private group in a test.
 */
export function profileGroups(own?: () => number | null): (gid: number, path: string) => boolean {
  return harmlessGroups("linux", own);
}

function nearestFolder(path: string): { dir: string; folder: Stats } | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try { return { dir, folder: lstatSync(dir) }; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dir === "/") return null; }
  }
}

/**
 * chosenHerdrSocketStatus for a socket a server selects once and keeps talking to for its life (the machine
 * profile), with `place`, what each later connection is held to (heldHerdrSocketStatus). Before anything
 * connects there, the walk to the nearest folder of the path that exists must be safe (`reason`: why it is not,
 * naming the folder, for the owner). "gone"
 * (absent, or a socket that does not answer) means the server will use whatever answers there later, so it is
 * "gone" only where no other account can put a socket: the path is normalized and lies under a trusted herdr
 * folder of this account, or under a configured one (`<home>/.config/herdr`, `<xdg>/herdr`) that does not exist
 * yet, and that nearest folder is this account's, reached through no link, and writable by no group or other
 * account. A herdr folder found only from a running server's environment counts only once it exists.
 */
export async function pinnedHerdrSocketStatus(path: string, host: HerdrDiscoveryHost = currentHost()): Promise<{ status: "usable" | "gone" | "refused"; place: HerdrSocketPlace; reason?: string }> {
  const scope = await discoveryScope(host);
  const configured = [join(host.home, ".config"), host.xdg].flatMap((root) => root?.startsWith("/") && !existsSync(join(root, "herdr")) ? [join(root, "herdr")] : []);
  const place = { dirs: [...scope.dirs, ...configured], uid: scope.uid, walk: placeWalk() };
  const nearest = nearestFolder(path);
  if (nearest === null) return { status: "refused", place };
  const reason = place.walk(nearest.dir);
  if (reason !== null) return { status: "refused", place, reason };
  const status = await chosenHerdrSocketStatus(path, host, scope);
  if (status !== "gone") return { status, place };
  if (normalize(path) !== path || !place.dirs.some((dir) => path.startsWith(dir + "/"))) return { status: "refused", place };
  const { dir, folder } = nearest;
  const own = folder.isDirectory() && folder.uid === place.uid && (folder.mode & 0o022) === 0 && realpathSync(dir) === dir;
  return { status: own ? "gone" : "refused", place };
}

/**
 * A pinned socket as it is now, checked before each connection to it: "usable" only while it is this account's
 * socket under `place`, its folder reached through no link and walked safely; "gone" while nothing is there.
 * It does not connect. The socket's own path is never resolved: macOS refuses realpath on a socket
 * (EOPNOTSUPP), and a last part that lstat calls a socket is no link.
 */
export function heldHerdrSocketStatus(path: string, place: HerdrSocketPlace): "usable" | "gone" | "refused" {
  try {
    const socket = lstatSync(path);
    const folder = dirname(path);
    return socket.isSocket() && socket.uid === place.uid && realpathSync(folder) === folder && place.dirs.some((dir) => path.startsWith(dir + "/")) && place.walk(folder) === null ? "usable" : "refused";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "gone" : "refused";
  }
}

/**
 * discoverHerdrSessions for the machine profile: a candidate whose walk from `/` refuses its folder is never
 * connected to and is not a session found, so one safe session beside an unsafe one is the one found. The rest,
 * this account's socket under its herdr folders and answering, is chosenHerdrSocketStatus's, as discovery's.
 * `refused`: the walk's reason for the first candidate it dropped (null: it dropped none), for the owner when no
 * session is found.
 */
export async function discoverPinnableHerdrSessions(host: HerdrDiscoveryHost = currentHost()): Promise<{ sessions: FoundHerdrSession[]; refused: string | null }> {
  const scope = await discoveryScope(host);
  const walk = placeWalk();
  const results = await Promise.all([...scope.paths].map(async (path): Promise<FoundHerdrSession | string | null> => {
    const unsafe = walk(dirname(path));
    if (unsafe !== null) return unsafe;
    if (await chosenHerdrSocketStatus(path, host, scope) !== "usable") return null;
    const session = sessionOf(path, scope.dirs);
    return { socket_path: path, ...(session ? { session } : {}), label: session ?? "Default session" };
  }));
  return {
    sessions: results.filter((result): result is FoundHerdrSession => result !== null && typeof result !== "string"),
    refused: results.find((result): result is string => typeof result === "string") ?? null,
  };
}

export async function discoverHerdrSessions(host: HerdrDiscoveryHost = currentHost()): Promise<FoundHerdrSession[]> {
  const scope = await discoveryScope(host);
  const results = await Promise.all([...scope.paths].map(async (path): Promise<FoundHerdrSession | null> => {
    if (await chosenHerdrSocketStatus(path, host, scope) !== "usable") return null;
    const session = sessionOf(path, scope.dirs);
    return { socket_path: path, ...(session ? { session } : {}), label: session ?? "Default session" };
  }));
  return results.filter((result): result is FoundHerdrSession => result !== null);
}

export function validHerdrSocket(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/") && value.endsWith("/herdr.sock") && !/[\0\r\n]/.test(value);
}

/** `home`: the listing PC's home, whose throwaway folders (throwawayPath) are left out too. */
export function parseFoundHerdrSessions(value: unknown, home?: string): FoundHerdrSession[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANDIDATES) throw new Error("The PC returned an invalid list of herdr sessions");
  return value.map((row: unknown) => {
    if (typeof row !== "object" || row === null || !("socket_path" in row) || !validHerdrSocket(row.socket_path)
      || !("label" in row) || typeof row.label !== "string" || row.label.length > 256
      || "session" in row && (typeof row.session !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.session))) throw new Error("The PC returned an invalid herdr session");
    return { socket_path: row.socket_path, label: row.label, ...("session" in row && typeof row.session === "string" ? { session: row.session } : {}) };
  }).filter((row) => { const session = row.session ?? sessionOf(row.socket_path); return !(session && testHerdrSession(session)) && !(home && throwawayPath(row.socket_path, home)); });
}
