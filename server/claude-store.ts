/**
 * Where Claude Code keeps a session's transcript: `<config dir>/projects/<project>/<session>.jsonl`,
 * the config dir being the process's `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 *
 * <project> is Claude's own encoding of the directory it started in (read from Claude Code
 * 2.1.284): every character that is not an ASCII letter or digit becomes `-`, and a name longer
 * than 200 characters keeps its first 200 plus `-` and a base-36 hash of the whole path. So
 * `my_project`, `example.com`, `.dotfiles`, `My Project` and a Korean folder all differ from a
 * plain `/` → `-` swap.
 *
 * The directory is only the fast path. The pane's cwd need not be the one Claude started in, and
 * Claude may change its encoding again, so a miss looks the session id up in every project: the
 * id is a UUID herdr reports, so at most one file answers to it.
 */

import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readFile, readdir, readlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath, { basename, dirname, isAbsolute, join, type PlatformPath } from "node:path";
import { directoryKey, withoutVerbatimPrefix } from "./codex.ts";
import { darwinStartTime, sysctlCall } from "./darwin-process.ts";
import { recentProcessTable } from "./gjc-runtime.ts";
import { processAlive, processStartUpperBoundAsync } from "./process-start.ts";
import { jobProcessesBelow, type JobProcess } from "./foreground-job.ts";
import { descendantProcesses, type ProcessRow } from "./windows-processes.ts";
import { userHome } from "./user-home.ts";

const MAX_PROJECT_NAME = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude's executable; a Windows one (backslashes or `.exe`) is matched without case, as Windows names files. */
function isClaudeExecutable(text = ""): boolean {
  return /(?:^|[\\/])claude(?:\.exe)?$/.test(/\\|\.exe$/i.test(text) ? text.toLowerCase() : text);
}

export function isClaudeProcess(entry: { name?: string; argv0?: string; argv?: readonly string[] }): boolean {
  // macOS keeps the executable name "node" for npm installs; the process title is argv0.
  if (isClaudeExecutable(entry.name) || isClaudeExecutable(entry.argv0) || isClaudeExecutable(entry.argv?.[0])) return true;
  // the native build runs under its version as the name and titles itself "Claude": both its
  // argv0 and its argv[0] say so, which one field alone does not prove
  return /^\d+\.\d+\.\d+$/.test(entry.name ?? "") && entry.argv0 === "Claude" && entry.argv?.[0] === "Claude";
}

/**
 * The Claude processes under a Windows pane's shell, from the process table: herdr and herdr-core
 * name only the shell in front there (windows-processes.ts). The nearest one, and any other not
 * started by it (two of them: which one a session belongs to cannot be told). The native claude.exe
 * the shell started can run the session in a child claude.exe, and only that child writes the PID
 * record: a Claude with no record file in any store hands over to the nearest Claudes below it that
 * have one (windowsLaunchedClaude). Null when the table says nothing, which is no proof that no
 * Claude runs there.
 */
export async function windowsShellClaude(shellPid: number, table: () => Promise<ProcessRow[]> = recentProcessTable, home = userHome()): Promise<{ pid: number; argv: string[] }[] | null> {
  const rows = await table();
  if (rows.length === 0) return null;
  const claude = nearestOf(rows, descendantProcesses(rows, shellPid).filter(isClaudeProcess));
  return (await Promise.all(claude.map((entry) => windowsLaunchedClaude(entry, rows, home)))).flat();
}

function nearestOf<T extends { pid: number }>(rows: readonly ProcessRow[], claude: T[]): T[] {
  const first = claude[0];
  if (first === undefined) return [];
  const below = new Set(descendantProcesses(rows, first.pid).map((entry) => entry.pid));
  return claude.filter((entry) => entry === first || !below.has(entry.pid));
}

/**
 * The Claude that runs the session `entry` started: `entry` itself, unless it has no PID record file
 * in any store and a Claude below it has one: then the nearest such Claude and any other that one
 * did not start, whatever their records say (the callers check them, and refuse a store that cannot
 * be told). Only a file's presence counts: a torn or leftover record still marks the Claude that
 * runs the session, so a Claude that one started (`claude -p`) never takes its place, and a Claude
 * beside it with no record is still told apart from none. A `claude attach` client writes no record
 * and names its session by its job: it counts as one that has a record, so it never hands over and
 * is never passed over.
 */
async function windowsLaunchedClaude(entry: { pid: number; argv: string[] }, rows: readonly ProcessRow[], home: string): Promise<{ pid: number; argv: string[] }[]> {
  const inner = descendantProcesses(rows, entry.pid).filter(isClaudeProcess);
  const named = (claude: { pid: number; argv: string[] }) => claudeAttachArgs(claude.argv) !== null || hasRecordFile(home, claude.pid);
  if (inner.length === 0 || await named(entry)) return [entry];
  const recorded = await Promise.all(inner.map(named));
  const holders = inner.filter((_, index) => recorded[index]);
  return holders.length > 0 ? nearestOf(rows, holders) : [entry];
}

/** Whether any store Claude may use has a PID record file of `pid`, readable or not; one that cannot be looked at counts as there. */
async function hasRecordFile(home: string, pid: number): Promise<boolean> {
  const found = await Promise.all((await knownClaudeStores(home)).map((store) => lstat(join(store, "sessions", `${pid}.json`)).then(() => true, (error: unknown) => !absent(error))));
  return found.includes(true);
}

/**
 * The Claude below a herdr-core terminal's foreground process, in its job (foreground-job.ts): a
 * launcher or script that runs Claude as its child (#3009). Only one Claude there is taken: with two,
 * which one the terminal shows cannot be told, and none is. Null when the job cannot be read.
 */
export async function jobClaude(pid: number): Promise<JobProcess[] | null> {
  const job = await jobProcessesBelow(pid);
  if (job === null) return null;
  const claude = job.filter((entry) => isClaudeProcess({ name: entry.name, argv: entry.argv, ...(entry.argv[0] === undefined ? {} : { argv0: entry.argv[0] }) }));
  return claude.length === 1 ? claude : [];
}

/** Java's String.hashCode, which Claude Code uses for the suffix of a long name. */
function stringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) - hash + text.charCodeAt(i) | 0;
  return hash;
}

export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_PROJECT_NAME) return name;
  return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

export function defaultClaudeConfigDir(home: string): string {
  return process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude");
}

/**
 * What a Claude process says of the store it writes: an exported CLAUDE_CONFIG_DIR (`dir` "" when
 * it was exported empty, which Claude reads as its default, told apart from none exported), none
 * exported (only a complete read of its environment proves that), an environment that could not be
 * read in full, or several Windows stores holding its PID record. Windows lets no one read another
 * process's environment: its PID record proves the store, not how it was chosen, so ~/.claude found
 * that way is `store` (an override may or may not have named it), and another store is an override.
 */
export type ClaudeSource =
  | { state: "override"; dir: string }
  | { state: "absent" }
  | { state: "store"; dir: string }
  | { state: "unreadable" }
  | { state: "ambiguous" };

/** What readClaudeSource found, by pid and argv, and when: a process's environment does not change. */
const processDirs = new Map<string, { read: SourceRead; at: number }>();
const PROCESS_DIR_TTL_MS = 30_000;
/** A read that told no store is kept only this long: a store folder made a moment later answers on the next try. */
const PROCESS_MISS_TTL_MS = 2_000;
const missed = (read: SourceRead) => read.source.state === "unreadable" || read.source.state === "ambiguous";

/**
 * The CLAUDE_CONFIG_DIR in one `ps -E -o command=` line: the last assignment, to the next `NAME=`.
 * As with CODEX_HOME, ps cannot distinguish an argument or a value containing ` NAME=` from an
 * assignment. A process that overwrites its argument/environment memory may expose no value.
 */
export function configDirInPsLine(text: string): string | null {
  return [...text.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].at(-1)?.[1] || null;
}

/**
 * What one store is known by, so that a directory reached two ways (another letter case, the
 * `\\?\` prefix, a junction) is one store, not two that both claim the process (#586): its volume
 * and file id where it has one, else its spelling without the prefix and with the drive letter in
 * one case. Past the drive letter case is kept: a case-sensitive directory's `.claude-Work` is
 * another store than `.claude-work`, and both go to the ambiguity check.
 */
export function claudeStoreKey(store: string, id: { dev: bigint; ino: bigint } | null, paths: PlatformPath = nodePath): string {
  return id !== null && id.ino !== 0n ? `${id.dev}:${id.ino}` : directoryKey(paths.resolve(withoutVerbatimPrefix(store)));
}

async function folderIdentity(path: string): Promise<string> {
  try { return claudeStoreKey(path, await stat(path, { bigint: true })); } catch { return claudeStoreKey(path, null); }
}

async function knownClaudeStores(home: string): Promise<string[]> {
  let siblings: string[] = [];
  try {
    siblings = (await readdir(home, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(".claude-"))
      .map((entry) => join(home, entry.name))
      .sort();
  } catch {}
  const stores = new Map<string, string>();
  for (const store of [defaultClaudeConfigDir(home), join(home, ".claude"), ...siblings]) {
    let id: { dev: bigint; ino: bigint } | null = null;
    try { id = await stat(store, { bigint: true }); } catch {}
    const key = claudeStoreKey(store, id);
    if (!stores.has(key)) stores.set(key, store);
  }
  return [...stores.values()];
}

export class AmbiguousClaudeStore extends Error {
  constructor(pid: number) {
    super(`more than one Claude store holds process ${pid}`);
    this.name = "AmbiguousClaudeStore";
  }
}

/**
 * Windows lets no other process read Claude's environment, so the store is the one holding the
 * process's live PID record (claudeProcessSession checks its start); null when none does, and
 * AmbiguousClaudeStore when several do (a store copied while Claude ran) or a record is there but
 * cannot be read (it may be the live one), never the default store.
 */
async function windowsProcessStore(home: string, pid: number, table: () => Promise<ProcessRow[]>): Promise<string | null> {
  const stores = await knownClaudeStores(home);
  const states = await Promise.all(stores.map((store) => recordState(home, pid, store, "win32", table)));
  const owners = stores.filter((_, index) => states[index] === "holds");
  if (owners.length > 1 || states.includes("unknown")) throw new AmbiguousClaudeStore(pid);
  return owners[0] ?? null;
}

/**
 * What one store says of a live PID record of `pid`: it holds it, it holds none (no file, or one a
 * finished process left), or unknown: a record file is there but cannot be read, which may be the
 * live one, so it is never taken for none.
 */
async function recordState(home: string, pid: number, store: string, platform: string, table: () => Promise<ProcessRow[]>): Promise<"holds" | "absent" | "unknown"> {
  try {
    return await claudeProcessSession(home, pid, store, platform, table, "throw") === null ? "absent" : "holds";
  } catch { return "unknown"; }
}

class UnreadableClaudeRecord extends Error {
  constructor(path: string, options: { cause: unknown }) {
    super(`cannot read Claude's PID record ${path}`, options);
    this.name = "UnreadableClaudeRecord";
  }
}

/**
 * Whether `dir` is the only store holding a live PID record of `pid` among `dir` and the stores
 * Claude may use (knownClaudeStores). A record names the process, not the store it writes: a store
 * copied while Claude ran (`cp -r ~/.claude ~/.claude-work`) holds the same live record, so two
 * holders prove neither. A record that is there but cannot be read leaves the answer unknown: false.
 */
export async function claudeRecordOnlyIn(
  home: string,
  pid: number,
  dir: string,
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<boolean> {
  const wanted = await folderIdentity(dir);
  const stores = new Map<string, string>([[wanted, dir]]);
  for (const store of await knownClaudeStores(home)) {
    const key = await folderIdentity(store);
    if (!stores.has(key)) stores.set(key, store);
  }
  const states = await Promise.all([...stores.values()].map((store) => recordState(home, pid, store, platform, table)));
  if (states.includes("unknown")) return false;
  const holders = [...stores.keys()].filter((_, index) => states[index] === "holds");
  return holders.length === 1 && holders[0] === wanted;
}

/**
 * A `KERN_PROCARGS2` answer: an int argc, the executable's path, its NUL padding, argc arguments,
 * then the environment, each NUL-terminated, up to an empty one or the end.
 */
export function procArgsEnvironment(answer: Uint8Array): string[] | null {
  const bytes = Buffer.from(answer.buffer, answer.byteOffset, answer.byteLength);
  if (bytes.length < 4) return null;
  const argc = bytes.readInt32LE(0);
  let at = bytes.indexOf(0, 4);
  if (argc < 0 || at < 0) return null;
  while (at < bytes.length && bytes[at] === 0) at++;
  const words: string[] = [];
  while (at < bytes.length) {
    const end = bytes.indexOf(0, at);
    if (end < 0) return null;
    const word = bytes.toString("utf8", at, end);
    at = end + 1;
    if (words.length >= argc && word === "") break;
    words.push(word);
  }
  return words.length < argc ? null : words.slice(argc);
}

const CTL_KERN = 1, KERN_ARGMAX = 8, KERN_PROCARGS2 = 49;

/**
 * A macOS process's environment as the kernel keeps it (sysctl KERN_PROCARGS2), NUL-joined as
 * /proc/<pid>/environ: each entry whole, so NOTE="example CLAUDE_CONFIG_DIR=<dir>" stays NOTE's,
 * which `ps -E`, joining them with spaces, cannot show. Null when it cannot be read (another
 * user's process, one gone).
 */
function darwinEnvironment(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const call = sysctlCall();
  const argmax = new Uint8Array(4);
  if (call(new Int32Array([CTL_KERN, KERN_ARGMAX]), argmax) === null) return null;
  const answer = new Uint8Array(new DataView(argmax.buffer).getInt32(0, true));
  const length = call(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]), answer);
  const entries = length === null ? null : procArgsEnvironment(answer.subarray(0, length));
  return entries === null ? null : entries.join("\0");
}

export const darwinProcess = { environment: darwinEnvironment, startTime: darwinStartTime };

async function namedDirectory(dir: string | null): Promise<string | null> {
  if (dir === null || !isAbsolute(dir)) return null;
  try { return (await stat(dir)).isDirectory() ? dir : null; } catch { return null; }
}

interface SourceRead { source: ClaudeSource; legacy: string | null }

async function overrideSource(value: string): Promise<ClaudeSource> {
  if (value === "") return { state: "override", dir: "" };
  const dir = await namedDirectory(value);
  return dir === null ? { state: "unreadable" } : { state: "override", dir };
}

/** A Linux process's environment as /proc/<pid>/environ holds it, read in full, as a source. */
async function environSource(environ: string): Promise<SourceRead> {
  const entries = environ.split("\0").filter((entry) => entry !== "");
  // an environment read empty is a process gone or not ours to read, not one without the variable
  if (entries.length === 0) return { source: { state: "unreadable" }, legacy: null };
  const named = entries.filter((entry) => entry.startsWith("CLAUDE_CONFIG_DIR=")).map((entry) => entry.slice(18));
  const legacy = await namedDirectory(named[0] || null);
  if (named.length > 1) return { source: { state: "unreadable" }, legacy };
  return { source: named.length === 0 ? { state: "absent" } : await overrideSource(named[0]!), legacy };
}

async function readClaudeSource(pid: number, home: string, platform: string, table: () => Promise<ProcessRow[]>): Promise<SourceRead> {
  const unreadable: SourceRead = { source: { state: "unreadable" }, legacy: null };
  try {
    if (platform === "win32") {
      const owner = await windowsProcessStore(home, pid, table);
      if (owner === null) return unreadable;
      const implicit = claudeStoreKey(owner, null) === claudeStoreKey(join(home, ".claude"), null);
      return { source: implicit ? { state: "store", dir: owner } : { state: "override", dir: owner }, legacy: await namedDirectory(owner) };
    }
    if (platform === "linux") return await environSource(await readFile(`/proc/${pid}/environ`, "utf8"));
    if (platform === "darwin") {
      const environ = darwinProcess.environment(pid);
      const source: ClaudeSource = environ === null ? { state: "unreadable" } : (await environSource(environ)).source;
      const child = Bun.spawn(["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 3000);
      let text: string;
      try {
        text = await new Response(child.stdout).text();
        await child.exited;
      } finally { clearTimeout(timer); }
      return { source, legacy: await namedDirectory(configDirInPsLine(text)) };
    }
    return unreadable;
  } catch (error) {
    if (error instanceof AmbiguousClaudeStore) return { source: { state: "ambiguous" }, legacy: null };
    return unreadable;
  }
}

/**
 * The source of a Claude process's store (ClaudeSource), kept for PROCESS_DIR_TTL_MS under the
 * process's pid and argv: /proc on Linux, sysctl KERN_PROCARGS2 (same user only) on macOS, the
 * store holding its PID record on Windows, where a process with no record yet is asked again on the
 * next read.
 */
async function processRead(pid: number, argv: readonly string[], home: string, platform: string, table: () => Promise<ProcessRow[]>): Promise<SourceRead> {
  const key = `${pid}\0${argv.join("\0")}`;
  const known = processDirs.get(key);
  if (known && Date.now() - known.at < (missed(known.read) ? PROCESS_MISS_TTL_MS : PROCESS_DIR_TTL_MS)) return known.read;
  const read = await readClaudeSource(pid, home, platform, table);
  processDirs.delete(key);
  // Claude writes its PID record as it starts: on Windows a miss is asked again on the next read,
  // and two stores holding it are remembered no more than a miss
  if (platform === "win32" && missed(read)) return read;
  processDirs.set(key, { read, at: Date.now() });
  if (processDirs.size > 256) processDirs.delete(processDirs.keys().next().value!);
  return read;
}

export async function processClaudeSource(
  pid: number,
  argv: readonly string[] = [],
  home = userHome(),
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<ClaudeSource> {
  return (await processRead(pid, argv, home, platform, table)).source;
}

/**
 * The store source a terminal herdr-core starts inherits: the environment of its core process
 * (`server.status`'s pid), which hc hands every shell it starts (a terminal's own env aside): read
 * from /proc on Linux and with sysctl on macOS (same user only). Windows lets no one read it, so the
 * bridge server's own (`env`) stands in, as for herdr.
 */
export async function processLaunchSource(pid: number, platform: string = process.platform, proc = "/proc", env: Record<string, string | undefined> = process.env): Promise<ClaudeSource> {
  if (platform !== "linux" && platform !== "darwin") return env["CLAUDE_CONFIG_DIR"] === undefined ? { state: "absent" } : overrideSource(env["CLAUDE_CONFIG_DIR"]);
  let environ: string | null = null;
  try { environ = platform === "linux" ? await readFile(join(proc, String(pid), "environ"), "utf8") : darwinProcess.environment(pid); } catch { /* gone, or not ours */ }
  // read empty: a process gone or not ours, not one without the variable
  if (!environ) return { state: "unreadable" };
  return (await environSource(environ)).source;
}

const launchSources = new Map<string, { inodes: string; source: ClaudeSource }>();

/**
 * The store source a new herdr tab inherits: the environment of the herdr server listening on
 * `socket`, which every shell it starts is handed (a tab's own env aside). A pane's shell does not
 * say it: it may have dropped or changed the variable herdr handed down. On Linux, the processes
 * holding that listening socket, each read in full from /proc, all the same source (unreadable when
 * none is found or they differ), kept while the socket's inode stays the same: a process's
 * environment does not change, and a restarted herdr listens on a new socket. macOS and Windows let
 * no one find herdr's environment, so the bridge server's own (`env`) stands in: both are
 * usually started from the same login. The resume route checks the store the new Claude came up
 * on either way, which also catches a shell startup file that exports the variable.
 */
export async function herdrLaunchSource(socket: string, platform: string = process.platform, proc = "/proc", env: Record<string, string | undefined> = process.env): Promise<ClaudeSource> {
  const unreadable: ClaudeSource = { state: "unreadable" };
  if (platform !== "linux") return env["CLAUDE_CONFIG_DIR"] === undefined ? { state: "absent" } : overrideSource(env["CLAUDE_CONFIG_DIR"]);
  try {
    // Num RefCount Protocol Flags Type St Inode Path; the listening one has __SO_ACCEPTCON
    const inodes = new Set((await readFile(join(proc, "net", "unix"), "utf8")).split("\n").slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length >= 8 && fields[3] === "00010000" && fields.slice(7).join(" ") === socket)
      .map((fields) => `socket:[${fields[6]}]`));
    if (inodes.size === 0) return unreadable;
    const cacheKey = `${proc}\0${socket}`;
    const inodeKey = [...inodes].sort().join(",");
    const known = launchSources.get(cacheKey);
    if (known?.inodes === inodeKey) return known.source;
    const sources: ClaudeSource[] = [];
    for (const entry of await readdir(proc)) {
      if (!/^\d+$/.test(entry)) continue;
      let fds: string[];
      try { fds = await readdir(join(proc, entry, "fd")); } catch { continue; /* gone, or not ours */ }
      for (const fd of fds) {
        let target: string;
        try { target = await readlink(join(proc, entry, "fd", fd)); } catch { continue; }
        if (!inodes.has(target)) continue;
        let environ = "";
        try { environ = await readFile(join(proc, entry, "environ"), "utf8"); } catch { /* read as empty: unreadable */ }
        sources.push((await environSource(environ)).source);
        break;
      }
    }
    const first = sources[0];
    if (first === undefined || sources.some((source) => JSON.stringify(source) !== JSON.stringify(first))) return unreadable;
    if (first.state !== "unreadable") launchSources.set(cacheKey, { inodes: inodeKey, source: first });
    return first;
  } catch {
    return unreadable;
  }
}

export type PaneProcess = { pid: number; name?: string | null; argv0?: string | null; argv?: readonly string[] | null };

export async function paneClaudeSource(
  processes: readonly PaneProcess[],
  home = userHome(),
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<ClaudeSource | null> {
  const claude = processes.filter((entry) => isClaudeProcess({ name: entry.name ?? undefined, argv0: entry.argv0 ?? undefined, argv: entry.argv ?? undefined }));
  if (claude.length === 0) return null;
  if (claude.length > 1) return { state: "ambiguous" };
  const only = claude[0]!;
  return processClaudeSource(only.pid, only.argv ?? [only.argv0 ?? only.name ?? ""], home, platform, table);
}

/**
 * The store a source lists and resumes in: its directory, how a resumed Claude is told it (`env`:
 * the variable to export; null: none, as the source had none), its key, a hash of the store's
 * identity (claudeStoreKey) and of that choice, its place, a hash of the identity alone (neither
 * says anything of the path), and whether the choice is known (`chosen`). An implicit ~/.claude
 * and one exported by name are two keys, one place: Claude reads its settings and sign-in by the
 * choice, and writes its transcripts to the place. A
 * Windows ~/.claude found by its PID record (`store`: how it was chosen cannot be told there) is
 * resumed with none exported, which reaches ~/.claude again. A pane with no Claude (`null`) has the
 * server's default store. Null when the source cannot be told: never the default store in its place.
 */
export async function claudeStoreOf(
  source: ClaudeSource | null,
  home = userHome(),
  env: Record<string, string | undefined> = process.env,
): Promise<{ dir: string; env: { CLAUDE_CONFIG_DIR: string } | null; key: string; place: string; chosen: boolean } | null> {
  const chosen = source ?? (env["CLAUDE_CONFIG_DIR"] === undefined ? { state: "absent" as const } : { state: "override" as const, dir: env["CLAUDE_CONFIG_DIR"] });
  let dir: string;
  let launch: { CLAUDE_CONFIG_DIR: string } | null;
  let how: string;
  switch (chosen.state) {
    case "override": dir = chosen.dir || join(home, ".claude"); launch = { CLAUDE_CONFIG_DIR: chosen.dir }; how = chosen.dir === "" ? "empty" : "explicit"; break;
    case "absent": dir = join(home, ".claude"); launch = null; how = "implicit"; break;
    case "store": dir = chosen.dir; launch = null; how = "unknown"; break;
    default: return null;
  }
  let id: { dev: bigint; ino: bigint } | null = null;
  try { id = await stat(dir, { bigint: true }); } catch {}
  const identity = claudeStoreKey(dir, id);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
  return { dir, env: launch, key: hash(`${how}\0${identity}`), place: hash(`place\0${identity}`), chosen: how !== "unknown" };
}

export async function processClaudeConfigDir(
  pid: number,
  argv: readonly string[] = [],
  home = userHome(),
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<string | null> {
  const read = await processRead(pid, argv, home, platform, table);
  if (read.source.state === "ambiguous") throw new AmbiguousClaudeStore(pid);
  return read.legacy;
}

/**
 * The store of a Claude the pane's processes cannot show (#3931): a sandbox wrapper such as
 * `bwrap --new-session` runs it in a session of its own, outside the pane's job. herdr's agent hint,
 * HERDR_AGENT=claude, marks the foreground processes the wrapper put in front of it, and their
 * CLAUDE_CONFIG_DIR is the store they hand Claude, read as a Claude process's own (Linux only). Only
 * the whole foreground job counts, so `processes` is herdr's list, never herdr-core's leader alone. Null
 * when none carries the hint or it names the default store; AmbiguousClaudeStore when they name more than
 * one, or a live one cannot be read, which may carry the hint and another store: a guess could be another
 * account's store.
 */
export async function hintedClaudeConfigDir(processes: readonly { pid?: number | null }[], proc = "/proc"): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const reads: { pid: number; read: SourceRead }[] = [];
  let unread: number | null = null;
  for (const { pid } of processes) {
    if (typeof pid !== "number") continue;
    let environ = "";
    try { environ = await readFile(join(proc, String(pid), "environ"), "utf8"); } catch { /* read as empty */ }
    // read empty: gone, or not ours to read, which may hide the hint and another store
    if (environ === "") {
      if (processAlive(pid)) unread ??= pid;
      continue;
    }
    if (!environ.split("\0").includes("HERDR_AGENT=claude")) continue;
    reads.push({ pid, read: await environSource(environ) });
  }
  if (unread !== null) throw new AmbiguousClaudeStore(unread);
  const first = reads[0];
  if (first === undefined) return null;
  const differs = reads.find(({ read }) => read.source.state === "unreadable" || JSON.stringify(read) !== JSON.stringify(first.read));
  if (differs !== undefined) throw new AmbiguousClaudeStore(differs.pid);
  return first.read.legacy;
}

/** Only an absent path is a miss: an unreadable store is an error to report, not an empty one. */
function absent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (error) { if (absent(error)) return false; throw error; }
}

const found = new Map<string, string>();

/** How much of a transcript's end is read for a `continued-in` record: only metadata follows one. */
const CONTINUED_TAIL_BYTES = 64 * 1024;

async function transcriptTail(path: string): Promise<{ text: string; identity: string } | null> {
  try {
    // no links and no blocking: a FIFO in its place must not hold the lookup (as branchedFrom)
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) return null;
      const size = Number(info.size);
      const start = Math.max(0, size - CONTINUED_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, identity: `${info.dev}:${info.ino}` };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/**
 * The session Claude continued in, when this transcript ends in a `continued-in` record with no
 * user or assistant turn after it. Only the file's tail is read, since this runs on every lookup.
 * A file that cannot be read names no continuation: its own reader reports the failure.
 */
async function continuedInSession(path: string): Promise<{ next: string | null; identity: string | null }> {
  const tail = await transcriptTail(path);
  if (tail === null) return { next: null, identity: null };
  let continued: string | null = null;
  for (const line of tail.text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; continuedInSessionId?: unknown };
      if (entry.type === "user" || entry.type === "assistant") continued = null;
      else if (entry.type === "continued-in" && typeof entry.continuedInSessionId === "string" && SESSION_ID.test(entry.continuedInSessionId)) {
        continued = entry.continuedInSessionId;
      }
    } catch {}
  }
  return { next: continued, identity: tail.identity };
}

/**
 * `/resume` of a session running in the background parks the pane on a continuation that never
 * gets a transcript; the conversation lives in the job's own `<8 hex>-*.jsonl` of the same project,
 * whose id the command prints as `running in the background (<8 hex>)`. Only an unambiguous
 * single match is taken, and the job's state.json, when it names a transcript, must agree.
 */
async function backgroundJobTranscript(path: string, configDir: string): Promise<string | null> {
  const text = (await transcriptTail(path))?.text ?? null;
  if (text === null) return null;
  let pending: string | undefined;
  let id: string | undefined;
  for (const line of text.split("\n")) {
    let type: unknown;
    try { type = (JSON.parse(line) as { type?: unknown }).type; } catch {}
    if (type === "continued-in") {
      id = pending;
      pending = undefined;
    } else {
      pending = [...line.matchAll(/running in the background \(([0-9a-f]{8})\)/g)].at(-1)?.[1] ?? pending;
    }
  }
  if (id === undefined) return null;
  let matches: string[];
  try {
    matches = (await readdir(dirname(path))).filter((name) => name.startsWith(`${id}-`) && name.endsWith(".jsonl"));
  } catch { return null; }
  if (matches.length !== 1) return null;
  const job = join(dirname(path), matches[0]!);
  try {
    // bounded, and no FIFO or link in its place: a state that cannot be read so cannot agree (#1876)
    const raw = await readSmallFile(join(configDir, "jobs", id, "state.json"), MAX_JOB_STATE_BYTES);
    if (raw === null) return null;
    const state = JSON.parse(raw) as { linkScanPath?: unknown };
    if (typeof state.linkScanPath === "string" && state.linkScanPath !== job) return null;
  } catch (error) {
    if (!(error instanceof SyntaxError || absent(error))) return null;
  }
  return await isFile(job) ? job : null;
}

/** How much of a transcript's start is read for the session it was branched from: a branch's first record carries it after the message. */
const BRANCH_HEAD_BYTES = 1024 * 1024;
const MAX_BRANCH_DEPTH = 8;
const MAX_BRANCH_PARENTS = 256;
const branchParents = new Map<string, { dev: number; ino: number; length: number; digest: string; parent: string | null }>();
const headDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The session `/branch` copied this transcript from: Claude Code (2.1.311) writes the conversation so far into a
 * new transcript in the same project, each copied record carrying `forkedFrom.sessionId`, and goes on in it. Only
 * the first conversation record (user or assistant) decides, and only when it is the file's own session's: Null when
 * it names no such session, belongs to another, or is not within BRANCH_HEAD_BYTES (no guess on a cut record).
 * Non-blocking and no symlinks, as readSmallFile.
 */
async function branchedFrom(path: string): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const info = await file.stat();
    if (!info.isFile()) return null;
    const known = branchParents.get(path);
    if (known && known.dev === info.dev && known.ino === info.ino && info.size >= known.length) {
      const head = Buffer.alloc(known.length);
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      if (bytesRead === head.length && headDigest(head) === known.digest) return known.parent;
    }
    const bytes = Buffer.alloc(Math.min(info.size, BRANCH_HEAD_BYTES));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const own = basename(path, ".jsonl");
    let end = 0;
    for (let next = bytes.indexOf(10, 0); next !== -1 && next < length; end = next + 1, next = bytes.indexOf(10, end)) {
      const line = bytes.subarray(end, next).toString("utf8");
      // every record is read as JSON reads it: a key written with escapes (`"\u0074ype"`) is the same key (#2130)
      if (line.trim() === "") continue;
      let entry: { type?: unknown; sessionId?: unknown; forkedFrom?: { sessionId?: unknown } | null };
      try { entry = JSON.parse(line); } catch { return null; }
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      const parent = entry.forkedFrom?.sessionId;
      const answer = entry.sessionId === own && typeof parent === "string" && SESSION_ID.test(parent) ? parent : null;
      if (branchParents.size >= MAX_BRANCH_PARENTS) branchParents.delete(branchParents.keys().next().value!);
      branchParents.set(path, { dev: info.dev, ino: info.ino, length: next + 1, digest: headDigest(bytes.subarray(0, next + 1)), parent: answer });
      return answer;
    }
    return null;
  } catch {
    return null;
  } finally { await file.close(); }
}

export function forgetClaudeSessions(): void {
  found.clear();
  branchParents.clear();
  attachedJobs.clear();
  processDirs.clear();
  launchSources.clear();
}

/**
 * macOS has no /proc: Claude records the process's start as `ps -o lstart` text in UTC, which a reused PID cannot repeat.
 * It records the C locale's order ("Fri Oct  9"); an en_GB server's ps would print "Fri  9 Oct" and match no record.
 */
async function darwinProcessStart(pid: number): Promise<string | null> {
  const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    const text = (await new Response(child.stdout).text()).replace(/\s+/g, " ").trim();
    await child.exited;
    return text || null;
  } finally { clearTimeout(timer); }
}

export function forgetClaudeSessionFile(path: string): void {
  branchParents.delete(path);
  for (const [key, value] of found) if (value === path) found.delete(key);
}

/** Windows: Claude records the start as FILETIME (100 ns since 1601), the process table in ms since 1970. */
function fileTimeMs(text: string): number | null {
  return /^\d+$/.test(text) ? Number(BigInt(text) / 10_000n - 11_644_473_600_000n) : null;
}

/**
 * Claude's native PID record names the current session even without Herdr's hook.
 * The process's exact start (ticks on Linux, `ps` lstart text on macOS, the process table's
 * start to the millisecond on Windows) rejects leftovers after a PID is reused. Read again on
 * every request: /clear and resume can change sessions in the same process. Other platforms and
 * older records without procStart keep the hook-only path.
 */
export async function claudeProcessSession(
  home: string,
  pid: number,
  configDir = join(home, ".claude"),
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
  unreadable: "none" | "throw" = "none",
): Promise<string | null> {
  if ((platform !== "linux" && platform !== "darwin" && platform !== "win32") || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const path = join(configDir, "sessions", `${pid}.json`);
    let text: string | null;
    try {
      text = await readSmallFile(path, 16 * 1024);
    } catch (error) {
      if (unreadable === "throw" && !absent(error)) throw new UnreadableClaudeRecord(path, { cause: error });
      throw error;
    }
    if (text === null) return null;
    const record: unknown = JSON.parse(text);
    if (record === null || typeof record !== "object" ||
      !("pid" in record) || record.pid !== pid ||
      !("kind" in record) || record.kind !== "interactive" ||
      !("sessionId" in record) || typeof record.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.sessionId) ||
      !("procStart" in record) || typeof record.procStart !== "string") return null;
    if (platform === "linux") {
      if (!/^\d+$/.test(record.procStart)) return null;
      const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = processStat.slice(processStat.lastIndexOf(") ") + 2).split(" ");
      if (fields[19] !== record.procStart) return null;
    } else if (platform === "win32") {
      const started = fileTimeMs(record.procStart);
      if (started === null || (await table()).find((row) => row.pid === pid)?.started !== started) return null;
    } else if (await darwinProcessStart(pid) !== record.procStart.replace(/\s+/g, " ").trim()) return null;
    return record.sessionId;
  } catch (error) {
    if (error instanceof UnreadableClaudeRecord) throw error;
    // A closed process, absent/older native store or a torn write gives no identity.
    if (error instanceof SyntaxError || absent(error) ||
      (error !== null && typeof error === "object" && "code" in error && ["EACCES", "EPERM", "ESRCH", "ELOOP", "ENXIO"].includes(String(error.code)))) return null;
    throw error;
  }
}

/**
 * A small file Claude Code keeps (a PID record, a job's state), or null when it is no regular file or
 * holds more than `max` bytes. Non-blocking and no symlinks: a FIFO or a link in its place must not
 * hang the read. The cap holds on the read itself, which a file growing after its stat cannot pass.
 */
async function readSmallFile(path: string, max: number): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) return null;
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    // One read may return less than the file holds; only a read of nothing is its end.
    for (;;) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length === bytes.length) return null;
    }
    return bytes.subarray(0, length).toString("utf8");
  } finally { await file.close(); }
}

/*
 * Claude Code's root options as 2.1.308 reads them when it looks for a subcommand such as `attach`
 * (its backgroundSessionVerbIndex). An option missing here makes an `attach` behind it no attach, so
 * an option a later Claude adds keeps such a pane on its terminal rather than on a guess (#1645).
 */
/** Root options that take the next argument as their value, whatever it looks like. */
const CLAUDE_VALUE_OPTIONS = new Set([
  "--prefill", "--prefill-b64", "--deep-link-repo", "--deep-link-last-fetch", "--deep-link-cwd-b64",
  "--handle-uri", "--settings", "--managed-settings", "--setting-sources", "--client-data-url",
  "--watch-artifact", "--watch-artifact-no-autoreact", "--team-name", "--agent-id", "--agent-name",
  "--agent-color", "--parent-session-id", "--agent-type", "--model", "--agent", "--routine",
  "--effort", "--fast-mode", "--permission-mode", "--inherit-permission-mode", "--proactivity",
  "--debug-file", "--system-prompt", "--system-prompt-file", "--append-system-prompt",
  "--append-system-prompt-file", "--system-prompt-snapshot", "--append-subagent-system-prompt",
  "--append-subagent-system-prompt-file", "--plan-mode-instructions", "--permission-prompt-tool",
  "--permission-prompts", "--json-schema", "--fallback-model", "--advisor", "--agents", "--name",
  "-n", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools",
  "--add-dir", "--mcp-config", "--betas", "--file", "--channels",
  "--dangerously-load-development-channels", "--plugin-dir", "--plugin-dir-no-mcp", "--plugin-url",
  "--remote-control-session-name-prefix", "--exec", "-m", "--sdk-url", "--thinking",
  "--thinking-display", "--max-thinking-tokens", "--max-turns", "--max-budget-usd", "--task-budget",
  "--autocompact", "--rewind-files", "--resume-session-at", "--resume-drops-turn", "--workload",
  "--output-format", "--input-format", "--teammate-mode", "--messaging-socket-path", "--session-id",
  "--environment", "--pool", "--ref", "--on-branch", "--correlation-id", "--forward-home-settings",
  "--project-config-root", "--attach-serve", "--runner-declares",
]);
/** Of those, the ones that also take every argument after it up to the next option. */
const CLAUDE_LIST_OPTIONS = new Set([
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools",
  "--add-dir", "--mcp-config", "--betas", "--file", "--channels",
  "--dangerously-load-development-channels",
]);
/** Root options that take the next argument only when it is no option. */
const CLAUDE_OPTIONAL_VALUE_OPTIONS = new Set([
  "-d", "--debug", "-r", "--resume", "--from-pr", "-w", "--worktree", "--teleport", "--cloud",
  "--remote", "--project", "--remote-control", "--rc", "--prompt-suggestions",
]);
/** The flags that may stand before a subcommand. */
const CLAUDE_FLAGS = new Set([
  "-d2e", "--debug-to-stderr", "--verbose", "-p", "--print", "--bare", "--safe-mode", "--init",
  "--init-only", "--maintenance", "--include-hook-events", "--include-partial-messages",
  "--forward-subagent-text", "--session-mirror", "--await-claim", "--await-initialize",
  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
  "--replay-user-messages", "--host-auth-is-org-sign-in", "--enable-auth-status", "--restricted",
  "--allow-other-models", "--exclude-dynamic-system-prompt-sections",
  "--include-unsupported-models", "-c", "--continue", "--fork-session", "--deep-link-origin",
  "--no-session-persistence", "--reply-on-resume", "--ide", "--desktop", "--strict-mcp-config",
  "--disable-slash-commands", "--chrome", "--no-chrome", "--tmux", "--enable-auto-mode", "--bg",
  "--background", "--brief", "--ax-screen-reader", "--plan-mode-required", "--hard-fail",
]);
/** Value options that may not stand before a subcommand. */
const CLAUDE_NOT_BEFORE_VERB = new Set(["--exec", "-m", "--handle-uri"]);
/** Options that make the command no subcommand at all: print, background, routine, help, version. */
const CLAUDE_NOT_WITH_VERB = new Set(["-p", "--print", "--bg", "--background", "--routine", "-h", "--help", "-v", "-V", "--version"]);

const JOB_ID = /^[0-9a-f]{8}$/;
/** Text Claude takes for the start of an id, never for part of a name. */
const JOB_ID_START = /^[a-f0-9]{1,8}$/;

const optionLike = (arg: string): boolean => arg.length > 1 && arg.startsWith("-");

/**
 * Whether every argument from `at` on is a debug option, or `--setting-sources` with its value: Claude
 * reads those wherever they stand, and still reads the argument before them as a job's name (#1876).
 * Any other argument there keeps the pane on its terminal, a debug value apart from `-d`/`--debug` too:
 * Claude (2.1.311) takes it for an extra argument and then looks no name up (#2125).
 */
function onlyDebugOptions(args: readonly string[], at: number): boolean {
  for (let index = at; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-d" || arg === "--debug" || arg === "-d2e" || arg === "--debug-to-stderr" || arg.startsWith("--debug=") || arg.startsWith("--setting-sources=")) continue;
    if (arg === "--setting-sources" && args[index + 1] !== undefined && !optionLike(args[index + 1]!)) { index++; continue; }
    return false;
  }
  return true;
}

function optionEnd(args: readonly string[], at: number): number {
  const option = args[at];
  if (option !== undefined && CLAUDE_OPTIONAL_VALUE_OPTIONS.has(option)) {
    const next = args[at + 1];
    return next !== undefined && !optionLike(next) ? at + 1 : at;
  }
  if (option === undefined || !CLAUDE_VALUE_OPTIONS.has(option)) return at;
  let end = at + 1;
  if (CLAUDE_LIST_OPTIONS.has(option)) while (end + 1 < args.length && !optionLike(args[end + 1]!)) end++;
  return end;
}

function firstOperand(args: readonly string[]): number {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") return at + 1 < args.length ? at + 1 : -1;
    if (!optionLike(arg)) return at;
    at = optionEnd(args, at);
  }
  return -1;
}

function optionBeforeVerb(option: string): boolean {
  if (CLAUDE_NOT_WITH_VERB.has(option) || option.startsWith("--routine=") || /^-[A-Za-z]{2,}$/.test(option)) return false;
  if (CLAUDE_FLAGS.has(option)) return true;
  const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
  return (CLAUDE_VALUE_OPTIONS.has(name) && !CLAUDE_NOT_BEFORE_VERB.has(name)) || CLAUDE_OPTIONAL_VALUE_OPTIONS.has(name);
}

export type ClaudeAttach = { ref: string; behindOptions: boolean; byName: boolean };

/**
 * What a `claude attach` process asked to open, read from its arguments as Claude reads them (after
 * `node <script>` for an npm install); null for any other Claude. `attach` is the first argument that
 * is neither an option nor an option's value. With root options before it, each must be one Claude
 * allows there and the job must be named by its whole eight-digit id. With none, the argument may be
 * the start of an id, or, when nothing but debug options and `--setting-sources` follow it, part of a
 * job's name (#1645, #1876).
 */
export function claudeAttachArgs(argv: readonly string[] | null | undefined): ClaudeAttach | null {
  const program = argv?.[0];
  if (argv === null || argv === undefined || program === undefined) return null;
  const args = argv.slice(/(?:^|[\\/])(?:node|bun)(?:\.exe)?$/i.test(program) ? 2 : 1);
  const at = firstOperand(args);
  if (at === -1 || args[at] !== "attach") return null;
  const ref = args[at + 1];
  // help, an unknown option or nothing: Claude prints its usage and exits
  if (ref === undefined || ref === "" || ref.startsWith("-")) return null;
  if (at === 0) return { ref, behindOptions: false, byName: onlyDebugOptions(args, 2) };
  if (args[at - 1] === "--" || !JOB_ID.test(ref)) return null;
  for (let index = 0; index < at; index = optionEnd(args, index) + 1) {
    if (!optionBeforeVerb(args[index]!)) return null;
  }
  return { ref, behindOptions: true, byName: false };
}

const MAX_JOB_STATE_BYTES = 256 * 1024;

function unreadableJobState(error: unknown): boolean {
  return error instanceof SyntaxError || absent(error) ||
    (error !== null && typeof error === "object" && "code" in error && ["EACCES", "EIO", "EPERM", "ELOOP", "ENXIO", "EISDIR", "EMFILE", "ENFILE"].includes(String(error.code)));
}

function nameRank(state: Record<string, unknown>, text: string): number {
  const name = typeof state["name"] === "string" ? state["name"].toLowerCase() : "";
  if (name === text) return 3;
  if (name.includes(text)) return 2;
  return [state["displayIntent"], state["intent"]].some((task) => typeof task === "string" && task.toLowerCase().includes(text)) ? 1 : 0;
}

/** A job over for good: done, failed or stopped and not active, unless it is done but wakes again (a routine, a self-wake, a cron, a /loop). */
function jobOver(state: Record<string, unknown>): boolean {
  const end = state["state"];
  if ((end !== "done" && end !== "failed" && end !== "stopped") || state["tempo"] === "active") return false;
  if (end !== "done") return true;
  const inFlight = state["inFlight"];
  const kinds = inFlight !== null && typeof inFlight === "object" ? (inFlight as { kinds?: unknown }).kinds : undefined;
  const loop = (text: unknown) => typeof text === "string" && text.trim().toLowerCase().startsWith("/loop");
  return !(state["routine"] !== undefined || state["selfWake"] === true || (Array.isArray(kinds) && kinds.includes("session_cron")) ||
    loop(state["intent"]) || loop(state["initialPrompt"]));
}

type JobState = Record<string, unknown> | "invalid" | "unreadable" | "absent";

async function readJobState(jobs: string, id: string): Promise<JobState> {
  try {
    const raw = await readSmallFile(join(jobs, id, "state.json"), MAX_JOB_STATE_BYTES);
    if (raw === null) return "unreadable";
    const state: unknown = JSON.parse(raw);
    return state !== null && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : "invalid";
  } catch (error) {
    if (absent(error)) return "absent";
    if (unreadableJobState(error)) return "unreadable";
    throw error;
  }
}

const JOB_STATE_READS = 8;

async function readJobStates(jobs: string, ids: readonly string[]): Promise<{ id: string; state: JobState }[]> {
  const states: { id: string; state: JobState }[] = [];
  for (let at = 0; at < ids.length; at += JOB_STATE_READS) {
    states.push(...await Promise.all(ids.slice(at, at + JOB_STATE_READS).map(async (id) => ({ id, state: await readJobState(jobs, id) }))));
  }
  return states;
}

/**
 * Whether Claude loads this state as a job, by its schema: the fields it requires are strings, and those
 * this lookup reads have the types it requires when there. Claude rejects a state for other fields too:
 * such a job, matching while the one a client opened matches too, keeps the pane on its terminal, and is
 * taken only once that job is renamed away and the lookup runs afresh (#1876).
 */
function loadsAsJob(state: Record<string, unknown>): boolean {
  const optional = (value: unknown, type: string) => value === undefined || typeof value === type;
  const inFlight = state["inFlight"];
  if (inFlight !== undefined) {
    if (inFlight === null || typeof inFlight !== "object") return false;
    const { tasks, queued, kinds } = inFlight as { tasks?: unknown; queued?: unknown; kinds?: unknown };
    if (typeof tasks !== "number" || typeof queued !== "number" || !Array.isArray(kinds) || !kinds.every((kind) => typeof kind === "string")) return false;
  }
  return ["state", "detail", "template", "intent", "sessionId", "cwd", "createdAt", "updatedAt"].every((field) => typeof state[field] === "string") &&
    ["name", "displayIntent", "initialPrompt", "routine"].every((field) => optional(state[field], "string"));
}

function madeAfter(state: JobState, started: number): boolean {
  return typeof state === "object" && typeof state["createdAt"] === "string" && Date.parse(state["createdAt"]) > started;
}

/**
 * The job a `claude attach` argument opens, found as Claude finds it: the one job whose id starts with
 * it; else, when it may be a name and is not the start of an id, the one job whose name holds it, any
 * other job whose task text holds it counting against that unless that job is over. Claude found it as
 * the client started, at `started` or before: a job made since is left out. Null where Claude would
 * find none or several, and when a job's state cannot be read to tell. Found after the client started
 * (the server came later), it may still be wrong once the job the client opened was renamed away while
 * an older one matches: renamed to match, or one Claude does not load (loadsAsJob, #1876).
 */
async function findAttachedJob(configDir: string, { ref, byName }: ClaudeAttach, started: number): Promise<string | null> {
  const jobs = join(configDir, "jobs");
  let entries: Dirent[];
  try { entries = await readdir(jobs, { withFileTypes: true }); } catch (error) { if (unreadableJobState(error)) return null; throw error; }
  const prefixed = entries.filter((entry) => JOB_ID.test(entry.name) && entry.name.startsWith(ref)).map((entry) => entry.name);
  if (prefixed.length > 0) {
    const older = (await readJobStates(jobs, prefixed)).filter((job) => !madeAfter(job.state, started));
    return older.length === 1 ? older[0]!.id : null;
  }
  const text = ref.trim().toLowerCase();
  if (!byName || text === "" || JOB_ID_START.test(text)) return null;
  const states = await readJobStates(jobs, entries.filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name)).map((entry) => entry.name));
  if (states.some((job) => job.state === "unreadable")) return null;
  const matches = states.flatMap(({ id, state }) => typeof state === "object" && loadsAsJob(state) && !madeAfter(state, started)
    ? [{ id, rank: nameRank(state, text), over: jobOver(state) }] : []).filter((job) => job.rank > 0);
  const open = matches.filter((job) => job.rank !== 1 || !job.over);
  return open.length === 1 && open[0]!.rank >= 2 ? open[0]!.id : null;
}

/**
 * The job each attach client found, by store, pid and argument, and when that process started. Claude
 * finds it once, as the client starts, so a job renamed or made later never moves the pane to another,
 * and another process given the same pid finds its own. A client is forgotten only once it is gone, and
 * one this cannot remember keeps its terminal. A miss is looked up again after a while.
 */
const attachedJobs = new Map<string, { pid: number; started: number; job: string | null; at: number }>();
const MAX_ATTACHED_JOBS = 256;
/** Two reads of one process's start: Linux's differ by a tick or two; macOS's are the kernel's own, kept to the margin they had when `ps` counted whole seconds. */
const SAME_START_MS = 2000;
const ATTACH_MISS_MS = 10_000;

export async function claudeAttachedJob(
  configDir: string,
  pid: number,
  attach: ClaudeAttach,
  startedBefore: (pid: number) => Promise<number | null> = processStartUpperBoundAsync,
  alive: (pid: number) => boolean = processAlive,
): Promise<string | null> {
  if (JOB_ID.test(attach.ref)) return attach.ref;
  const started = await startedBefore(pid);
  if (started === null) return null;
  const key = `${configDir}\0${pid}\0${attach.byName}\0${attach.ref}`;
  const known = attachedJobs.get(key);
  if (known !== undefined && Math.abs(known.started - started) <= SAME_START_MS &&
    (known.job !== null || Date.now() - known.at < ATTACH_MISS_MS)) return known.job;
  if (known === undefined && attachedJobs.size >= MAX_ATTACHED_JOBS) {
    // a client is gone once no signal reaches its pid, or its pid starts another process (a signal
    // cannot tell a reused pid); a start that cannot be read now tells neither, and keeps it
    for (const [other, entry] of [...attachedJobs]) {
      let gone = !alive(entry.pid);
      if (!gone) {
        const now = await startedBefore(entry.pid);
        gone = now !== null && Math.abs(now - entry.started) > SAME_START_MS;
      }
      if (gone && attachedJobs.get(other) === entry) attachedJobs.delete(other);
    }
    if (attachedJobs.size >= MAX_ATTACHED_JOBS) return null;
  }
  const job = await findAttachedJob(configDir, attach, started);
  attachedJobs.set(key, { pid, started, job, at: Date.now() });
  return job;
}

/**
 * Claude Code keeps a job's state in `<config dir>/jobs/<job>/state.json`: `resumeSessionId`, which
 * /clear and a respawn move on, else the `sessionId` it started with.
 */
export async function claudeJobSession(configDir: string, job: string): Promise<string | null> {
  try {
    const text = await readSmallFile(join(configDir, "jobs", job, "state.json"), MAX_JOB_STATE_BYTES);
    if (text === null) return null;
    const state: unknown = JSON.parse(text);
    if (state === null || typeof state !== "object") return null;
    const { resumeSessionId, sessionId } = state as { resumeSessionId?: unknown; sessionId?: unknown };
    const session = resumeSessionId ?? sessionId;
    return typeof session === "string" && SESSION_ID.test(session) ? session : null;
  } catch (error) {
    if (unreadableJobState(error)) return null;
    throw error;
  }
}

/**
 * Whether a process runs in a background session's environment (CLAUDE_CODE_SESSION_KIND=bg), where
 * Claude reads no subcommand behind root options and runs an interactive Claude; null when its
 * environment cannot be read (Windows, a process gone or not ours) or names the kind twice.
 */
async function inBackgroundSession(pid: number, platform: string): Promise<boolean | null> {
  let environ: string | null = null;
  try {
    if (platform === "linux") environ = await readFile(`/proc/${pid}/environ`, "utf8");
    else if (platform === "darwin") environ = darwinProcess.environment(pid);
  } catch { /* gone, or not ours to read */ }
  const entries = environ?.split("\0").filter((entry) => entry !== "") ?? [];
  // an environment read empty is a process gone or not ours to read, not one without the variable
  if (entries.length === 0) return null;
  const kinds = entries.filter((entry) => entry.startsWith("CLAUDE_CODE_SESSION_KIND="));
  return kinds.length > 1 ? null : kinds[0] === "CLAUDE_CODE_SESSION_KIND=bg";
}

export async function claudeAttachSession(
  configDir: string, pid: number, argv: readonly string[] | null | undefined, platform: string = process.platform,
): Promise<{ session: string | null } | null> {
  const attach = claudeAttachArgs(argv);
  if (attach === null) return null;
  if (attach.behindOptions) {
    const background = await inBackgroundSession(pid, platform);
    if (background === true) return null;
    // maybe an attach client: neither its job nor a session an earlier Claude in the pane reported
    if (background === null) return { session: null };
  }
  const job = await claudeAttachedJob(configDir, pid, attach);
  return { session: job === null ? null : await claudeJobSession(configDir, job) };
}

/**
 * The session a pane's one Claude process names in its own PID record, which Claude rewrites when
 * /clear or /resume switches it to another session in the same process, or, for a `claude attach`
 * client, the session of the job it opened (claudeAttachSession); null when the pane has no single
 * Claude process or neither can be trusted (claudeProcessSession).
 */
export async function claudeForegroundSession(
  processes: readonly { pid: number; name?: string | null; argv0?: string | null; argv?: readonly string[] | null }[],
  home = userHome(),
): Promise<string | null> {
  const claude = processes.filter((entry) => isClaudeProcess({ name: entry.name ?? undefined, argv0: entry.argv0 ?? undefined, argv: entry.argv ?? undefined }));
  if (claude.length !== 1) return null;
  const only = claude[0]!;
  try {
    const dir = await processClaudeConfigDir(only.pid, only.argv ?? [only.argv0 ?? only.name ?? ""], home) || defaultClaudeConfigDir(home);
    // a `claude attach` client keeps no PID record: its job's state names the session it shows (#1876)
    const attach = await claudeAttachSession(dir, only.pid, only.argv);
    if (attach !== null) return attach.session;
    return await claudeProcessSession(home, only.pid, dir);
  } catch {
    // two stores claim the process, or one cannot be read: no session to pin
    return null;
  }
}

/**
 * `live` is the session the pane's Claude process names in its own PID record. `/branch` moves the
 * process to a copy of the conversation, and Herdr's report can stay on the session it was copied
 * from (#2020): the live session's transcript is taken when its records say they were branched
 * from this one (or from a branch of it) in the same project. A live session that is no branch of
 * it, as after a `/resume` back, changes nothing.
 */
export async function claudeTranscriptFile(
  home: string, session: string, cwds: readonly (string | null | undefined)[], configDir = join(home, ".claude"), live: string | null = null,
  proofs?: Map<string, string>,
): Promise<string | null> {
  const projects = join(configDir, "projects");
  const locate = async (id: string): Promise<string | null> => {
    const file = `${id}.jsonl`;
    for (const cwd of cwds) {
      if (!cwd) continue;
      const path = join(projects, claudeProjectDir(cwd), file);
      if (await isFile(path)) return path;
    }
    const key = `${projects}\0${id}`;
    const known = found.get(key);
    if (known !== undefined && await isFile(known)) return known;
    found.delete(key);
    let entries: string[];
    try { entries = await readdir(projects); } catch (error) { if (absent(error)) return null; throw error; }
    const checks = await Promise.allSettled(entries.map(async (entry) => {
      const path = join(projects, entry, file);
      return await isFile(path) ? path : null;
    }));
    for (const check of checks) {
      if (check.status === "fulfilled" && check.value !== null) { found.set(key, check.value); return check.value; }
    }
    const failed = checks.find((check) => check.status === "rejected");
    if (failed) throw failed.reason;
    return null;
  };

  const follow = async (start: string, seen: Set<string>, from?: string, prove = true): Promise<string | null> => {
    // this walk's own reads: the path it returns carries this walk's proof, or none, never another walk's
    const walk = new Map<string, string>();
    const settle = (found: string): string => {
      proofs?.delete(found);
      const identity = walk.get(found);
      if (prove && identity !== undefined) proofs?.set(found, identity);
      return found;
    };
    seen.add(start);
    let path = from ?? await locate(start);
    while (path !== null) {
      const { next, identity } = await continuedInSession(path);
      if (identity !== null) walk.set(path, identity);
      if (next === null || seen.has(next)) return settle(path);
      seen.add(next);
      // a branch's continuation goes on beside it: the same id in a project an earlier cwd names is another
      // conversation (#2130). One whose file is not there keeps the transcript that named it, unless a
      // /resume of a background session names that job's own transcript
      const beside = join(dirname(path), `${next}.jsonl`);
      const nextPath = (from !== undefined && await isFile(beside) ? beside : await locate(next)) ?? await backgroundJobTranscript(path, configDir);
      if (nextPath === null) return settle(path);
      path = nextPath;
    }
    return null;
  };

  const seen = new Set<string>();
  const path = await follow(session, seen);
  // a Claude started inside the pane inherits HERDR_PANE_ID and can take Herdr's report of the pane: a session
  // with no transcript, or one print mode wrote, is no conversation of the pane's own Claude (#3260)
  // the live session is looked for only where the pane's conversation can be: beside the report, or with no
  // report in the folders of the pane's own cwds, never in another project
  const folders = path !== null ? [dirname(path)]
    : cwds.flatMap((cwd) => cwd ? [join(projects, claudeProjectDir(cwd))] : []);
  const own = await ownSessionInstead(path, live, seen, folders, follow);
  if (own !== null) return own;
  if (path === null || live === null || !SESSION_ID.test(live) || seen.has(live)) return path;
  // a branch stays in its project: only that folder is looked in, and what cannot be read there is no evidence of one
  const inProject = async (id: string): Promise<string | null> => {
    const candidate = join(dirname(path), `${id}.jsonl`);
    try { return await isFile(candidate) ? candidate : null; } catch { return null; }
  };
  const livePath = await inProject(live);
  let branch = livePath;
  for (let depth = 0; branch !== null && depth < MAX_BRANCH_DEPTH; depth++) {
    const parent = await branchedFrom(branch);
    if (parent === null) return path;
    if (seen.has(parent)) {
      // from the very file found to be the branch: the same id may name another file elsewhere
      // the branch was told by branchedFrom's own read, not this tail's: the path it gives carries no proof (#3402)
      try { return await follow(live, seen, livePath!, false) ?? path; } catch { return path; }
    }
    branch = await inProject(parent);
  }
  return path;
}

const ENTRYPOINT_TAIL_BYTES = 256 * 1024;

/**
 * The `entrypoint` the newest record within a transcript's last ENTRYPOINT_TAIL_BYTES names ("cli", "sdk-cli"),
 * or null when none does or the file cannot be read. Whole records only, read as JSON reads them (#2130).
 * Non-blocking and no symlinks, as branchedFrom.
 */
async function lastEntrypoint(path: string): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const info = await file.stat();
    if (!info.isFile()) return null;
    const length = Math.min(info.size, ENTRYPOINT_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(bytes, read, length - read, info.size - length + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const lines = bytes.subarray(0, read).toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!.trim();
      if (line === "") continue;
      let entry: { entrypoint?: unknown };
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry?.entrypoint === "string") return entry.entrypoint;
    }
    return null;
  } catch {
    return null;
  } finally { await file.close(); }
}

/** Print mode and the SDK (`claude -p`) write an `sdk-…` entrypoint. */
async function printModeTranscript(path: string): Promise<boolean> {
  return (await lastEntrypoint(path))?.startsWith("sdk") === true;
}

/**
 * The transcript of the session the pane's Claude process names in its PID record (`live`), in place of the one
 * Herdr reports, when that report cannot be the pane's conversation: no project holds its transcript, or print
 * mode or the SDK wrote its newest records. A Claude started inside the pane (`claude -p` from a hook, a script or
 * the agent itself) inherits HERDR_PANE_ID, and its SessionStart can take the pane's report (#3260). Null keeps
 * the answer as it was: no PID record, a live session the report's chain already holds, a live session with no
 * transcript either or, beside a print-mode report, one print mode wrote too; an interactive report always stands,
 * as after a /resume back (#2020).
 */
async function ownSessionInstead(
  reported: string | null, live: string | null, seen: ReadonlySet<string>, folders: readonly string[],
  follow: (start: string, seen: Set<string>, from?: string) => Promise<string | null>,
): Promise<string | null> {
  if (live === null || !SESSION_ID.test(live) || seen.has(live)) return null;
  if (reported !== null && !await printModeTranscript(reported)) return null;
  let found: string | null = null;
  for (const folder of folders) {
    const candidate = join(folder, `${live}.jsonl`);
    // a regular file of its own, not a link to something else
    try { if ((await lstat(candidate)).isFile()) { found = candidate; break; } } catch { /* not there */ }
  }
  if (found === null) return null;
  const path = await follow(live, new Set<string>(), found);
  if (path === null || reported === null) return path;
  return await printModeTranscript(path) ? null : path;
}

const claudeTempRoots = (): string[] => [...new Set([tmpdir(), "/tmp"])];

/** The `claude-<uid>` folders every session's temp folder (`claudeSessionTempDir`) lies in; none on Windows, which has no uid. */
export function claudeTempBases(uid: number | undefined = process.getuid?.()): string[] {
  return uid === undefined ? [] : claudeTempRoots().map((root) => join(root, `claude-${uid}`));
}

/**
 * The folder Claude Code keeps for a session's own files outside the project, such as the
 * `scratchpad/` it names in prose by a relative path: `<tmp>/claude-<uid>/<project>/<session>/`,
 * <project> and <session> being the transcript's folder and name. Only a `claude-<uid>` folder
 * this user owns is read (another user could make it first in a shared /tmp). Null when there is
 * none, and on Windows, which has no uid.
 */
export async function claudeSessionTempDir(
  transcript: string,
  roots: readonly string[] = claudeTempRoots(),
  uid: number | undefined = process.getuid?.(),
): Promise<string | null> {
  if (uid === undefined || !transcript.endsWith(".jsonl")) return null;
  const session = basename(transcript, ".jsonl");
  if (!SESSION_ID.test(session)) return null;
  const project = basename(dirname(transcript));
  for (const root of roots) {
    const base = join(root, `claude-${uid}`);
    try {
      if ((await stat(base)).uid !== uid) continue;
      const dir = join(base, project, session);
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {}
  }
  return null;
}
