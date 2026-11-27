import { closeSync, fstatSync, openSync, opendirSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { darwinProcess } from "./claude-store.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processStartIdentity } from "./process-start.ts";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GROUPS = 4096;
/** Linux appends this to `/proc/<pid>/exe` after the inode is unlinked. */
const DELETED_SUFFIX = " (deleted)";
/** Packaging only. A version such as `grok-1.0.52` keeps its dots. */
const EXECUTABLE_SUFFIXES = [".cjs", ".mjs", ".exe", ".js"];
const LAUNCHER = /(^|[\\/])(?:bun|node)(?:\.exe)?$/i;

export interface GrokProcessInfo { foreground_processes?: { pid: number; argv?: string[] | null }[] }
function isGrokLauncher(argv: readonly string[]): boolean {
  return LAUNCHER.test(argv[0] ?? "") && isGrokExecutable(argv[1] ?? "");
}
export function grokPaneProcesses(info: GrokProcessInfo): { pid: number }[] {
  return (info.foreground_processes ?? []).filter((p) => {
    const argv = p.argv ?? [];
    return isGrokExecutable(argv[0] ?? "") || isGrokLauncher(argv);
  });
}

/** True when this path's file name is Grok: `grok`, or `grok-` plus anything else
 * (`grok-1.0.52-linux-x86_64`, `grok.exe`). The session is the one Herdr reported, when that
 * events.jsonl is open. */
export function isGrokExecutable(exePath: string): boolean {
  const slash = Math.max(exePath.lastIndexOf("/"), exePath.lastIndexOf("\\"));
  let name = slash >= 0 ? exePath.slice(slash + 1) : exePath;
  if (name.endsWith(DELETED_SUFFIX)) name = name.slice(0, -DELETED_SUFFIX.length);
  name = name.toLowerCase();
  for (;;) {
    const suffix = EXECUTABLE_SUFFIXES.find((candidate) => name.endsWith(candidate));
    if (!suffix) break;
    name = name.slice(0, -suffix.length);
  }
  return name === "grok" || name.startsWith("grok-");
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** The resolved store and its cwd groups (URI-encoded or native hashed names), or null when
 * the store is missing, not absolute or holds too many entries to trust. */
export function grokSessionGroups(home: string): { store: string; groups: string[] } | null {
  if (!isAbsolute(home)) return null;
  try {
    const store = realpathSync(join(home, "sessions"));
    const entries = opendirSync(store);
    const groups: string[] = [];
    let count = 0;
    try {
      for (let group = entries.readSync(); group; group = entries.readSync()) {
        if (++count > MAX_GROUPS) return null;
        if (group.isDirectory()) groups.push(group.name);
      }
    } finally { entries.closeSync(); }
    return { store, groups };
  } catch { return null; }
}

/** Search by exact ID, including native hashed cwd groups. Neither cwd nor mtime selects
 * a conversation. Duplicate custom IDs across groups are ambiguous and fail closed. */
export function grokTranscriptPath(home: string, session: string): string | null {
  if (!SESSION.test(session)) return null;
  const listed = grokSessionGroups(home);
  if (listed === null) return null;
  const { store, groups } = listed;
  let found: string | null = null;
  for (const group of groups) {
    const candidate = join(store, group, session, "updates.jsonl");
    try {
      const path = realpathSync(candidate);
      // Reject a link into another session as well as links outside the store.
      if (path !== candidate || !inside(store, path) || !statSync(path).isFile()) continue;
      if (found !== null) return null;
      found = path;
    } catch { }
  }
  return found;
}

const MAX_LISTED_FILES = 4096;
const MAX_LISTING_BYTES = 1024 * 1024;
const MAX_ACTIVE_SESSIONS_BYTES = 1024 * 1024;

/** Do not substitute the bridge's home when the pane's environment is unreadable. */
export function grokHomeFromEnvironment(environment: string): string | null {
  const fields = environment.split("\0");
  const explicit = fields.find((field) => field.startsWith("GROK_HOME="))?.slice(10);
  const userHome = fields.find((field) => field.startsWith("HOME="))?.slice(5)
    || fields.find((field) => field.startsWith("USERPROFILE="))?.slice(12);
  const home = explicit || (userHome ? join(userHome, ".grok") : null);
  return home && isAbsolute(home) ? home : null;
}

/**
 * The session directory of a held store path. An invalid events-file shape fails closed;
 * another held file records its apparent session directory so a missing events.jsonl there
 * cannot hide a renamed newer session.
 */
function heldSessionDir(store: string, target: string, others: Set<string>): string | null | undefined {
  if (!inside(store, target)) return undefined;
  const parts = relative(store, target).split(sep);
  if (!basename(target).startsWith("events.jsonl")) {
    if (parts.length >= 3) others.add(join(store, parts[0]!, parts[1]!));
    return undefined;
  }
  if (parts.length !== 3 || !SESSION.test(parts[1]!) ||
      basename(target) !== "events.jsonl" || realpathSync(target) !== target) return null;
  return dirname(target);
}

/** Held events.jsonl directories and descriptor write times. Null on an unreadable or oversized
 * table, or on evidence that could hide a renamed, deleted or replaced session events file. */
export function grokHeldSessions(pid: number, home: string): Map<string, number> | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const fds = opendirSync(`/proc/${pid}/fd`);
    const sessions = new Map<string, number>();
    const others = new Set<string>();
    let count = 0;
    try {
      for (let fd = fds.readSync(); fd; fd = fds.readSync()) {
        if (++count > MAX_LISTED_FILES) return null;
        const descriptor = `/proc/${pid}/fd/${fd.name}`;
        let target: string;
        try { target = readlinkSync(descriptor); } catch { continue; }
        const dir = heldSessionDir(store, target, others);
        if (dir === undefined) continue;
        if (dir === null) return null;
        const held = statSync(descriptor);
        const named = statSync(target);
        if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino) return null;
        sessions.set(dir, held.mtimeMs);
      }
    } finally { fds.closeSync(); }
    for (const folder of others) {
      if (sessions.has(folder)) continue;
      // a folder whose events file is gone may hold it under the other name
      if (!statSync(join(folder, "events.jsonl"), { throwIfNoEntry: false })?.isFile()) return null;
    }
    return sessions;
  } catch { return null; }
}

/** One numeric lsof descriptor. `dev` and `ino` are null when lsof did not report them. */
export interface GrokLsofFile { path: string; dev: number | null; ino: number | null }

/** Open files and the executable from `lsof -FfDin`. Numeric descriptors are the holds Linux
 * would see in /proc/pid/fd. The first txt entry is the executable; macOS also lists mapped
 * files as txt after it. cwd, rtd and mem are not holds. */
export function grokLsofEvidence(text: string): { executable: string | null; files: GrokLsofFile[] } | null {
  // -F without -0 terminates every field with a newline, including the last name.
  if (!text.endsWith("\n")) return null;
  const records: { fd: string; dev: number | null; ino: number | null; name: string | null }[] = [];
  const number = (field: string): number | null => {
    // Number() reads lsof's 0x-prefixed device as well as the decimal inode.
    const parsed = field === "" ? Number.NaN : Number(field);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  for (const line of text.split("\n")) {
    const last = records.at(-1);
    if (line.startsWith("f")) {
      if (records.push({ fd: line.slice(1), dev: null, ino: null, name: null }) > MAX_LISTED_FILES) return null;
    } else if (line.startsWith("n")) {
      if (!last || last.name !== null) return null;
      last.name = line.slice(1);
    } else if (last && line.startsWith("D")) last.dev = number(line.slice(1));
    else if (last && line.startsWith("i")) last.ino = number(line.slice(1));
  }
  // A shortened listing may end after a descriptor's identity but before its name. That
  // descriptor could be a newer session, so the remaining named records are not complete evidence.
  if (records.some((record) => record.name === null || record.name === "")) return null;
  const named = records.filter((record): record is typeof record & { name: string } => record.name !== null);
  return {
    executable: named.find((record) => record.fd === "txt")?.name ?? null,
    files: named.filter((record) => /^\d/.test(record.fd)).map(({ name, dev, ino }) => ({ path: name, dev, ino })),
  };
}

/** The same held-file rules as grokHeldSessions, using lsof's device and inode in place of
 * the /proc descriptor stat. A missing device or inode is not a match. */
export function grokHeldSessionsFromLsof(files: readonly GrokLsofFile[], home: string): Map<string, number> | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const sessions = new Map<string, number>();
    const others = new Set<string>();
    for (const file of files) {
      const dir = heldSessionDir(store, file.path, others);
      if (dir === undefined) continue;
      if (dir === null || file.dev === null || file.ino === null) return null;
      const named = statSync(file.path);
      if (!named.isFile() || named.dev !== file.dev || named.ino !== file.ino) return null;
      sessions.set(dir, named.mtimeMs);
    }
    for (const folder of others) {
      if (sessions.has(folder)) continue;
      if (!statSync(join(folder, "events.jsonl"), { throwIfNoEntry: false })?.isFile()) return null;
    }
    return sessions;
  } catch { return null; }
}

async function lsofListing(pid: number): Promise<string | null> {
  const child = Bun.spawn(["/usr/sbin/lsof", "-nPbw", "-a", "-p", String(pid), "-FfDin"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
  const bytes = await new Response(child.stdout).bytes();
  return await child.exited === 0 && bytes.byteLength <= MAX_LISTING_BYTES ? new TextDecoder().decode(bytes) : null;
}

function reportedSessionPath(home: string, sessionId: string, held: Map<string, number> | null): string | null {
  if (!held) return null;
  // A duplicate held ID is ambiguous even if only one directory has updates.jsonl.
  const reported = [...held.keys()].filter((dir) => basename(dir) === sessionId);
  if (reported.length !== 1) return null;
  const sessionDir = reported[0]!;
  const written = held.get(sessionDir)!;
  for (const [dir, mtime] of held) {
    // Equal timestamps cannot prove which session was written most recently.
    if (dir !== sessionDir && mtime >= written) return null;
  }
  const path = grokTranscriptPath(home, sessionId);
  return path !== null && dirname(path) === sessionDir ? path : null;
}

function linuxGrokExecutable(pid: number): boolean {
  try { return isGrokExecutable(readlinkSync(`/proc/${pid}/exe`)); }
  catch { return false; }
}

/** Direct children of every thread of a Linux process (/proc/<pid>/task/<tid>/children). */
function linuxThreadChildren(pid: number): number[] | null {
  const tasks = readdirSync(`/proc/${pid}/task`);
  if (tasks.length > MAX_LISTED_FILES) return null;
  const children = new Set<number>();
  for (const task of tasks) {
    const list = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
    for (const word of list.split(/\s+/)) {
      if (word === "") continue;
      const child = Number(word);
      if (Number.isSafeInteger(child) && child > 0) children.add(child);
    }
  }
  return [...children];
}

/** Retry once when a thread exits while reading /proc/<pid>/task, as server/foreground-job.ts does. */
function linuxChildren(pid: number): number[] | null {
  try { return linuxThreadChildren(pid); }
  catch {
    try { return linuxThreadChildren(pid); }
    catch { return null; }
  }
}

/**
 * The single Grok owner process for a pane: prefer a Grok executable in argv[0] over a bun/node
 * launcher (classic herdr lists both). When only one launcher is listed, on Linux take its single
 * direct child whose /proc/<pid>/exe is a Grok executable and that stays in the launcher's process
 * group (the pane's foreground job). Anything else is ambiguous and returns null.
 */
export function grokOwnerPid(info: GrokProcessInfo, platform: string = process.platform): number | null {
  const direct: number[] = [];
  const launchers: number[] = [];
  for (const p of info.foreground_processes ?? []) {
    const argv = p.argv ?? [];
    if (isGrokExecutable(argv[0] ?? "")) direct.push(p.pid);
    else if (isGrokLauncher(argv)) launchers.push(p.pid);
  }
  if (direct.length > 0) {
    if (direct.length !== 1) return null;
    const pid = direct[0]!;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (platform === "linux") return linuxGrokExecutable(pid) ? pid : null;
    return platform === "darwin" ? pid : null;
  }
  if (launchers.length !== 1) return null;
  const launcher = launchers[0]!;
  if (!Number.isSafeInteger(launcher) || launcher <= 0) return null;
  if (platform === "darwin") return launcher;
  if (platform !== "linux") return null;
  const children = linuxChildren(launcher);
  if (children === null) return null;
  const group = linuxStatNumber(launcher, PGRP_FIELD);
  if (group === null) return null;
  const grokChildren = children.filter((child) => linuxGrokExecutable(child) && linuxStatNumber(child, PGRP_FIELD) === group);
  return grokChildren.length === 1 ? grokChildren[0]! : null;
}

/** /proc/<pid>/stat fields counted from the one after `(comm)`: 5 (pgrp) and 22 (starttime). */
const PGRP_FIELD = 2;
const START_FIELD = 19;

function linuxStatNumber(pid: number, field: number): number | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(") ");
    if (close < 0) return null;
    const raw = text.slice(close + 2).split(" ")[field];
    if (raw === undefined || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  } catch { return null; }
}

/** Field 22 (starttime, clock ticks) of /proc/<pid>/stat, matching Grok's active_sessions.json `pid_start`. */
function linuxPidStart(pid: number): number | null {
  return linuxStatNumber(pid, START_FIELD);
}

/** The file's bytes read through one descriptor, or null when it is not a file or exceeds `max`. */
function readBounded(path: string, max: number): Buffer | null {
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return length > max ? null : buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/**
 * Stand-in for herdr's session report on Linux when herdr names none (herdr-core): read
 * `<GROK_HOME>/active_sessions.json` bounded, validate every entry, and pick the strictly latest
 * `opened_at` matching both `pid` and `pid_start`. Still confirmed by `reportedSessionPath`.
 */
export function grokActiveSession(home: string, pid: number, pidStart: number): string | null {
  if (!isAbsolute(home) || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pidStart) || pidStart < 0) return null;
  let parsed: unknown;
  try {
    const raw = readBounded(join(home, "active_sessions.json"), MAX_ACTIVE_SESSIONS_BYTES);
    if (raw === null) return null;
    parsed = JSON.parse(raw.toString("utf8"));
  } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  let latest: { id: string; at: number } | null = null;
  let tied = false;
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const id = record["session_id"];
    const entryPid = record["pid"];
    const entryStart = record["pid_start"];
    const openedAt = record["opened_at"];
    const cwd = record["cwd"];
    if (typeof id !== "string" || !SESSION.test(id)) return null;
    if (typeof entryPid !== "number" || !Number.isSafeInteger(entryPid) || entryPid <= 0) return null;
    if (typeof entryStart !== "number" || !Number.isSafeInteger(entryStart) || entryStart < 0) return null;
    // millisecond precision: two sessions opened in the same millisecond tie, and a tie fails closed
    const at = typeof openedAt === "string" ? Date.parse(openedAt) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    if (cwd !== undefined && typeof cwd !== "string") return null;
    if (entryPid !== pid || entryStart !== pidStart) continue;
    if (latest === null || at > latest.at) {
      latest = { id, at };
      tied = false;
    } else if (at === latest.at) {
      tied = true;
    }
  }
  return latest !== null && !tied ? latest.id : null;
}

function herdrReportedGrokSession(pane: HerdrPane): { present: boolean; id: string | null } {
  const session = pane.agent_session;
  if (session?.agent !== "grok" || session.kind !== "id" || session.source !== "herdr:grok") {
    return { present: false, id: null };
  }
  return { present: true, id: SESSION.test(session.value) ? session.value : null };
}

async function resolveDarwinGrokStore(paneId: string, pid: number, started: bigint, sessionId: string, configuredHome: string | undefined): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const listed = await lsofListing(pid);
  const evidence = listed === null ? null : grokLsofEvidence(listed);
  if (evidence === null || !isGrokExecutable(evidence.executable ?? "")) return null;
  // the environment as the kernel keeps it, each entry whole, as /proc/<pid>/environ on Linux
  const environment = configuredHome === undefined ? darwinProcess.environment(pid) : null;
  const home = configuredHome ?? (environment === null ? null : grokHomeFromEnvironment(environment));
  if (!home) return null;
  const path = reportedSessionPath(home, sessionId, grokHeldSessionsFromLsof(evidence.files, home));
  if (darwinProcess.startTime(pid) !== started) return null;
  // The initial foreground list may predate the sampled process. Confirm membership again,
  // then bracket that asynchronous RPC with the same kernel birth time as the evidence.
  const current = grokOwnerPid((await paneProcessInfo(paneId)) ?? {}, "darwin");
  return current === pid && darwinProcess.startTime(pid) === started ? path : null;
}

/** Bind Herdr's exact ID (or, on Linux when herdr names none, the owner process's latest
 * `active_sessions.json` entry) only when its unique held directory has the newest events.jsonl.
 * Linux reads /proc. macOS reads lsof and the kernel's copy of the environment. Windows stays
 * on the terminal view.
 * Write times confirm that ID; they never select a different conversation. */
export async function resolveGrokStore(pane: HerdrPane, configuredHome?: string, platform: string = process.platform): Promise<string | null> {
  return (await resolveGrokSession(pane, configuredHome, platform))?.path ?? null;
}

/**
 * resolveGrokStore's file with the pid of the Grok process that writes it, the same process
 * (its birth identity) before and after the lookup.
 */
export async function resolveGrokSession(pane: HerdrPane, configuredHome?: string, platform: string = process.platform): Promise<{ path: string; pid: number } | null> {
  if (pane.agent !== "grok" || (platform !== "linux" && platform !== "darwin")) return null;
  const reported = herdrReportedGrokSession(pane);
  if (reported.present) {
    if (reported.id === null) return null;
  } else if (platform !== "linux") {
    return null;
  }
  try {
    const ownerPid = grokOwnerPid((await paneProcessInfo(pane.pane_id)) ?? {}, platform);
    if (ownerPid === null) return null;
    if (platform === "darwin") {
      const started = darwinProcess.startTime(ownerPid);
      const path = started === null ? null : await resolveDarwinGrokStore(pane.pane_id, ownerPid, started, reported.id!, configuredHome);
      return path === null ? null : { path, pid: ownerPid };
    }
    const started = processStartIdentity(ownerPid);
    if (started === null) return null;
    const pidStart = reported.present ? null : linuxPidStart(ownerPid);
    if (!reported.present && pidStart === null) return null;
    const home = configuredHome ?? grokHomeFromEnvironment(readFileSync(`/proc/${ownerPid}/environ`, "utf8"));
    if (!home) return null;
    const sessionId = reported.present ? reported.id! : grokActiveSession(home, ownerPid, pidStart!);
    if (sessionId === null) return null;
    const held = grokHeldSessions(ownerPid, home);
    if (!reported.present) {
      // The registry names a session by pid alone: confirm the pid is still this pane's owner, the
      // same process, after every read, so a pid reused by another pane's Grok never binds here.
      if (linuxPidStart(ownerPid) !== pidStart) return null;
      if (grokOwnerPid((await paneProcessInfo(pane.pane_id)) ?? {}, platform) !== ownerPid) return null;
      if (linuxPidStart(ownerPid) !== pidStart) return null;
    }
    const path = reportedSessionPath(home, sessionId, held);
    return path !== null && processStartIdentity(ownerPid) === started ? { path, pid: ownerPid } : null;
  } catch { return null; }
}

/**
 * The pane's Grok session file when herdr names none (no Grok hook installed): the one session whose events.jsonl
 * the pane's Grok process holds open, on Linux. Only the waiting call is read from it (record-cards.ts), and only
 * while the dialog on the screen shows that call's whole command; the chat never binds this way, as a held file
 * alone does not choose which conversation to show (resolveGrokStore).
 */
export async function grokHeldTranscript(pane: HerdrPane, configuredHome?: string, platform: string = process.platform): Promise<string | null> {
  if (pane.agent !== "grok" || platform !== "linux") return null;
  try {
    const ownerPid = grokOwnerPid((await paneProcessInfo(pane.pane_id)) ?? {}, platform);
    if (ownerPid === null) return null;
    const home = configuredHome ?? grokHomeFromEnvironment(readFileSync(`/proc/${ownerPid}/environ`, "utf8"));
    const held = home ? grokHeldSessions(ownerPid, home) : null;
    if (!home || held === null || held.size !== 1) return null;
    const [dir] = held.keys();
    const path = grokTranscriptPath(home, basename(dir!));
    return path !== null && dirname(path) === dir ? path : null;
  } catch { return null; }
}
