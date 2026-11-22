import { opendirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { darwinProcess } from "./claude-store.ts";
import { paneProcessInfo } from "./herdr/client.ts";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GROUPS = 4096;
/** Linux appends this to `/proc/<pid>/exe` after the inode is unlinked. */
const DELETED_SUFFIX = " (deleted)";
/** Packaging only. A version such as `grok-1.0.52` keeps its dots. */
const EXECUTABLE_SUFFIXES = [".cjs", ".mjs", ".exe", ".js"];

export interface GrokProcessInfo { foreground_processes?: { pid: number; argv?: string[] | null }[] }
export function grokPaneProcesses(info: GrokProcessInfo): { pid: number }[] {
  return (info.foreground_processes ?? []).filter((p) => {
    const argv = p.argv ?? [];
    return isGrokExecutable(argv[0] ?? "") ||
      (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && isGrokExecutable(argv[1] ?? ""));
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

async function resolveDarwinGrokStore(paneId: string, pid: number, sessionId: string, configuredHome: string | undefined): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const started = darwinProcess.startTime(pid);
  if (started === null) return null;
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
  const current = grokPaneProcesses((await paneProcessInfo(paneId)) ?? {});
  return current.length === 1 && current[0]!.pid === pid && darwinProcess.startTime(pid) === started ? path : null;
}

/** Bind Herdr's exact ID only when its unique held directory has the newest events.jsonl.
 * Linux reads /proc. macOS reads lsof and the kernel's copy of the environment. Windows stays
 * on the terminal view.
 * Write times confirm that ID; they never select a different conversation. */
export async function resolveGrokStore(pane: HerdrPane, configuredHome?: string, platform: string = process.platform): Promise<string | null> {
  const session = pane.agent_session;
  if (pane.agent !== "grok" || session?.agent !== "grok" || session.kind !== "id" || session.source !== "herdr:grok" || !SESSION.test(session.value)) return null;
  // The executable may be any Grok build. Herdr's id chooses the session; an events.jsonl it did not name does not.
  if (platform !== "linux" && platform !== "darwin") return null;
  try {
    const processes = grokPaneProcesses((await paneProcessInfo(pane.pane_id)) ?? {});
    if (processes.length !== 1) return null;
    const owner = processes[0]!;
    if (platform === "darwin") return await resolveDarwinGrokStore(pane.pane_id, owner.pid, session.value, configuredHome);
    if (!isGrokExecutable(readlinkSync(`/proc/${owner.pid}/exe`))) return null;
    const home = configuredHome ?? grokHomeFromEnvironment(readFileSync(`/proc/${owner.pid}/environ`, "utf8"));
    if (!home) return null;
    return reportedSessionPath(home, session.value, grokHeldSessions(owner.pid, home));
  } catch { return null; }
}
