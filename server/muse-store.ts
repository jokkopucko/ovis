/**
 * Which Muse Code session a pane shows. herdr labels the pane `muse` but reports no session for
 * it, and argv names one only after `muse resume <id>`. Muse writes `.session.lock` into every
 * session directory it opens (`pid=<pid>`, and `host=<host>` on recent builds) and never deletes
 * it; a session the TUI switches away from ends its log with `session.end`.
 */
import { accessSync, closeSync, constants, type Dir, fstatSync, opendirSync, openSync, readSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo, type ProcessInfo } from "./herdr/client.ts";
import { processStartUpperBoundAsync } from "./process-start.ts";

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A process's start is an upper bound: up to a second late on macOS (the kernel's start, plus one),
 * and up to two 10 ms ticks late on Linux. macOS keeps the three seconds it had when `ps` told the
 * start in whole seconds.
 */
const START_SLACK_MS = process.platform === "darwin" ? 3000 : 20;
const TAIL_BYTES = 64 * 1024;
/** A lock holds a pid and a host name; only this much of it is read. */
const LOCK_BYTES = 1024;

/** `muse` itself, or the versioned `muse-bin-<version>` binary its launcher runs. */
export function isMuseExecutable(argv0: string): boolean {
  const name = basename(argv0.replace(/\\/g, "/")).replace(/\.exe$/i, "");
  return name === "muse" || name.startsWith("muse-bin-");
}

/** Where Muse keeps its data: `$XDG_DATA_HOME/muse`, else `~/.local/share/muse`. */
export function defaultMuseData(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "muse");
}

/** The pid and host a session lock names; null for any other content (a subagent's lock is empty). */
export function parseMuseLock(text: string): { pid: number; host: string | null } | null {
  const pid = /^pid=(\d+)$/m.exec(text)?.[1];
  return pid === undefined ? null : { pid: Number(pid), host: /^host=(.+)$/m.exec(text)?.[1] ?? null };
}

function readPart(path: string, bytes: number, fromEnd = false): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, bytes));
    const got = readSync(fd, buffer, 0, buffer.length, fromEnd ? size - buffer.length : 0);
    return buffer.subarray(0, got).toString("utf8");
  } catch { return null; } finally { closeSync(fd); }
}

/**
 * The log exists and its last complete record is not `session.end`. A record still being
 * written counts as live; a log not created yet does not, since the lock can come first.
 */
export function museSessionLive(path: string): boolean {
  const tail = readPart(path, TAIL_BYTES, true);
  if (tail === null) return false;
  const lines = tail.split("\n");
  if (lines.pop() !== "") return true;
  return lines.at(-1)?.includes('"payload_type":"session.end"') !== true;
}

/** Host names compared by their first label, as `mini` and `mini.local` name one PC. */
const sameHost = (a: string, b: string): boolean => a.split(".")[0]!.toLowerCase() === b.split(".")[0]!.toLowerCase();

const MAX_SESSIONS = 4096;

function names(dir: string, pattern: RegExp): string[] | null {
  let handle: Dir;
  try { handle = opendirSync(dir); } catch { return []; }
  const found: string[] = [];
  try {
    for (let count = 1, entry = handle.readSync(); entry !== null; count++, entry = handle.readSync()) {
      if (count > MAX_SESSIONS) return null;
      if (pattern.test(entry.name)) found.push(entry.name);
    }
  } catch {} finally { handle.closeSync(); }
  return found;
}

export interface MuseOwner { pid: number; startedAt: number }

/** Until when a scan that bound nothing stands, by store and pids: the monitor resolves such a pane every 2 s. */
const missed = new Map<string, number>();
const MISS_MS = 2000;

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 64) map.delete(map.keys().next().value!);
}

/**
 * The log in `dir` when its lock names one of `owners` (with this host, when it names one), the
 * lock was written since that process started and the log has not ended; else null. A
 * lock left by an earlier process that had the same pid is older than this one; a session the
 * process switched away from has ended.
 */
function heldLog(dir: string, owners: readonly MuseOwner[], host: string): string | null {
  const lock = join(dir, ".session.lock");
  let held = false;
  try {
    const written = statSync(lock).mtimeMs;
    const fresh = owners.filter((owner) => written >= owner.startedAt - START_SLACK_MS);
    if (fresh.length === 0) return null;
    const named = parseMuseLock(readPart(lock, LOCK_BYTES) ?? "");
    if (named === null || (named.host !== null && !sameHost(named.host, host))) return null;
    held = fresh.some((owner) => owner.pid === named.pid);
  } catch { return null; }
  const log = join(dir, "session.jsonl");
  if (!held) return null;
  if (museSessionLive(log)) return log;
  try { accessSync(log, constants.R_OK); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MuseLogUnreadable(); }
  return null;
}

/** The session log this pane's Muse holds is there, and cannot be read (its mode, its owner). */
export class MuseLogUnreadable extends Error {
  constructor() { super("Muse session log is unreadable"); this.name = "MuseLogUnreadable"; }
}

export function museSessionFor(data: string, owners: MuseOwner[], host = hostname(), now = Date.now()): string | null {
  const scan = `${owners.map((owner) => owner.pid).sort((a, b) => a - b).join(",")}\0${data}`;
  if ((missed.get(scan) ?? 0) > now) return null;
  const found = scanStore(data, owners, host);
  if (found === null) {
    remember(missed, scan, now + MISS_MS);
    return null;
  }
  missed.delete(scan);
  return found;
}

function scanStore(data: string, owners: readonly MuseOwner[], host: string): string | null {
  // sessions/YYYY/MM/DD/<id>
  let dirs = [join(data, "sessions")];
  for (const pattern of [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/, SESSION]) {
    const next: string[] = [];
    for (const dir of dirs) {
      const found = names(dir, pattern);
      if (found === null) return null;
      for (const name of found) if (next.push(join(dir, name)) > MAX_SESSIONS) return null;
    }
    dirs = next;
  }
  let found: string | null = null;
  for (const dir of dirs) {
    const held = heldLog(dir, owners, host);
    if (held === null) continue;
    if (found !== null) return null;
    found = held;
  }
  return found;
}

/**
 * A `muse` launcher that stays alive beside its `muse-bin-…` child holds no lock of its own.
 */
export async function resolveMuseSession(pane: HerdrPane, data = defaultMuseData(), known?: ProcessInfo | null): Promise<string | null> {
  try {
    const info = known === undefined ? await paneProcessInfo(pane.pane_id) : known;
    const pids = (info?.foreground_processes ?? []).filter((p) => Number.isSafeInteger(p.pid) && p.pid > 1 && isMuseExecutable(p.argv?.[0] ?? p.argv0 ?? "")).map((p) => p.pid);
    const owners = (await Promise.all(pids.map(async (pid) => ({ pid, startedAt: await processStartUpperBoundAsync(pid) }))))
      .filter((owner): owner is MuseOwner => owner.startedAt !== null);
    return owners.length === 0 ? null : museSessionFor(data, owners);
  } catch (error) {
    if (error instanceof MuseLogUnreadable) throw error;
    return null;
  }
}
