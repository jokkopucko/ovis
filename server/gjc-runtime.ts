/** GJC transcript identity is published by its lifecycle extension; shared terminal/store helpers are also used by omp. */

import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import nodePath, { join, type PlatformPath } from "node:path";

import { readGjcNativeBinding, validateGjcNativeTranscript } from "./gjc-native.ts";
import { darwinTerminal } from "./darwin-process.ts";
import { herdrRpc } from "./herdr/client.ts";
import { processStartedAt, processStartedAtAsync } from "./process-start.ts";
import { userHome } from "./user-home.ts";
import { descendantArgv, windowsProcessTable, type ProcessRow } from "./windows-processes.ts";

export interface GjcTerminal { id: string; startedAt: number }

/**
 * An agent run natively or as a bun/node script, as process_info names either: `executable`
 * matches its binary or script path (a Windows process comes with backslashes and `.exe`).
 */
export function runsAgent(argv: readonly string[], executable: RegExp): boolean {
  return executable.test(argv[0] ?? "") ||
    (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && executable.test(argv[1] ?? ""));
}

const GJC_EXECUTABLE = /(^|[\\/])gjc(?:\.exe|\.[cm]?js)?$/i;

export function isGjcProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, GJC_EXECUTABLE);
}

const PROCESS_TABLE_MS = 5000;
let processTable: { at: number; rows: Promise<ProcessRow[]> } | null = null;

/**
 * The Windows process table, read at most once per PROCESS_TABLE_MS. The chat polls a pane
 * every 2 s and each read starts a PowerShell (about 1.3 s on a real PC), so the polls of a
 * few seconds share one; a gjc that left its pane can still count as running for that long.
 */
export function recentProcessTable(read: () => Promise<ProcessRow[]> = windowsProcessTable, now = Date.now()): Promise<ProcessRow[]> {
  if (processTable && now - processTable.at < PROCESS_TABLE_MS) return processTable.rows;
  const entry = { at: now, rows: read() };
  processTable = entry;
  // an empty table is a read that failed: the next poll asks again
  void entry.rows.then((rows) => { if (rows.length === 0 && processTable === entry) processTable = null; });
  return entry.rows;
}

let freshReads = 0;
let freshTable: { read: () => Promise<ProcessRow[]>; started: number; rows: Promise<ProcessRow[]> } | null = null;

/**
 * A fresh Windows process table for the final PID-reuse check. Concurrent lookups share a read only
 * when it started after their own initial check (`after`), so N GJC panes start one PowerShell, not N.
 */
function freshProcessTable(read: () => Promise<ProcessRow[]>, after: number): Promise<ProcessRow[]> {
  if (freshTable && freshTable.read === read && freshTable.started > after) return freshTable.rows;
  const entry = { read, started: ++freshReads, rows: Promise.resolve().then(read) };
  freshTable = entry;
  const clear = () => { if (freshTable === entry) freshTable = null; };
  void entry.rows.then(clear, clear);
  return entry.rows;
}

/** A gjc process by its number and when it started: a number alone comes back for another process. */
export type GjcProcess = { pid: number; started: number | null };

/**
 * The gjc process below a pane's shell on a Windows PC, or null. herdr names only the shell
 * there (windows-processes.ts), so the PC's process table answers; elsewhere herdr's
 * foreground processes are the answer and the table is never asked. undefined: the table could
 * not be read (a query that timed out answers no rows), which says nothing about gjc.
 */
export async function gjcPidUnderShell(
  shellPid: unknown,
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<GjcProcess | null | undefined> {
  if (platform !== "win32" || typeof shellPid !== "number") return null;
  const rows = await table();
  if (rows.length === 0) return undefined;
  const seen = new Set<number>([shellPid]);
  let level = [shellPid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const row of rows) {
      if (!level.includes(row.parent) || seen.has(row.pid)) continue;
      // nearest first: the session's own process, not the helper gjc starts below itself
      if (descendantArgv([row], row.parent).some(isGjcProcess)) return { pid: row.pid, started: row.started ?? null };
      seen.add(row.pid);
      next.push(row.pid);
    }
    level = next;
  }
  return null;
}

type LookupToken = { cancelled: boolean };
const lookupsInFlight = new Map<string, Set<LookupToken>>();

/** Forget the Windows process-table snapshot and cancel reads belonging to ended server state. */
export function forgetGjcState(): void {
  for (const lookups of lookupsInFlight.values()) for (const lookup of lookups) lookup.cancelled = true;
  lookupsInFlight.clear();
  processTable = null;
  freshTable = null;
}

/** Cancel a pane's in-flight native identity checks when its pane ends. */
export function forgetGjcPane(paneId: string): void {
  const lookups = lookupsInFlight.get(paneId);
  if (!lookups) return;
  for (const lookup of lookups) lookup.cancelled = true;
  lookupsInFlight.delete(paneId);
}

/**
 * Where `file` sits inside `root`, as path segments, or null when it is not inside. The
 * platform's own rules decide: a Windows path comes with backslashes and a drive letter whose
 * case means nothing, and a prefix test would take `sessions-evil` or a `..` for the store.
 */
export function storeRelative(root: string, file: string, paths: PlatformPath = nodePath): string[] | null {
  const relative = paths.relative(root, file);
  // another drive or share comes back absolute
  if (relative === "" || paths.isAbsolute(relative)) return null;
  const parts = relative.split(paths.sep);
  return parts[0] === ".." ? null : parts;
}

/**
 * GJC's native terminal-sessions key, not the most recently written cwd session. `environ`, when
 * given (null: unreadable), stands in for /proc/<pid>/environ, which is then never read here.
 */
export function gjcTerminal(pid: number, environ?: readonly string[] | null): GjcTerminal | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const startedAt = processStartedAt(pid);
      if (startedAt === null) return null;
      const env = environ === undefined ? readFileSync(`/proc/${pid}/environ`, "utf8").split("\0") : environ ?? [];
      const tmux = env.find((word) => word.startsWith("TMUX="))?.slice(5);
      const pane = env.find((word) => word.startsWith("TMUX_PANE="))?.slice(10);
      if (tmux && pane && /^%\d+$/.test(pane)) return { id: `tmux-${pane}`, startedAt };
      const tty = readlinkSync(`/proc/${pid}/fd/0`);
      if (!/^\/dev\/(?:pts\/\d+|tty[\w-]+)$/.test(tty)) return null;
      return { id: tty.slice(5).replaceAll("/", "-"), startedAt };
    }
    if (process.platform === "darwin") {
      // the terminal and the start from one kernel record, as `ps -o tty= -o lstart=` read them, without a
      // child process that holds the event loop
      const record = darwinTerminal(pid);
      return record !== null && /^ttys\d+$/.test(record.tty) ? { id: record.tty, startedAt: record.startedAt } : null;
    }
  } catch { /* process exited or its terminal metadata is unavailable */ }
  return null;
}

/**
 * The cwd a gjc or omp transcript names in its header (`{"type":"session",...}`), or null when
 * the file is not one. omp writes a title record before the header. Read bounded: only the
 * header decides, and a rejected candidate can be megabytes.
 */
function transcriptCwd(path: string): string | null {
  return transcriptHeader(path)?.cwd ?? null;
}

/** transcriptCwd's header, with the session version it names (undefined when it names none). */
export function transcriptHeader(path: string): { cwd: string; version: unknown } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null; // the file vanished between the listing and this read
  }
  try {
    const buffer = Buffer.alloc(4096);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, size).toString("utf8").split("\n");
    let header = JSON.parse(lines[0] ?? "") as { type?: string; cwd?: unknown; version?: unknown };
    if (header.type === "title") header = JSON.parse(lines[1] ?? "") as { type?: string; cwd?: unknown; version?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? { cwd: header.cwd, version: header.version } : null;
  } catch {
    return null; // not a gjc transcript, or a header longer than the read
  } finally {
    closeSync(fd);
  }
}

/**
 * Shared breadcrumb/descriptor lookup: GJC and omp subagents live beside their session file, so
 * this helper maps such a path to its parent, which must itself be a session inside the store once
 * links are followed. `depth` is where sessions sit: 2 for `<cwd>/<id>.jsonl`, 1 for a session
 * directory of omp's own holding `<id>.jsonl`. The pane resolver uses the explicit lifecycle record.
 */
export function gjcSessionFile(root: string, path: string, paths: PlatformPath = nodePath, depth: 1 | 2 = 2): string | null {
  const parts = path.endsWith(".jsonl") ? storeRelative(root, path, paths) : null;
  if (!parts) return null;
  if (parts.length === depth) return path;
  if (parts.length !== depth + 1) return null;
  const session = paths.join(root, ...parts.slice(0, depth - 1), `${parts[depth - 1]!}.jsonl`);
  try {
    if (!statSync(session).isFile()) return null;
    // a parent linked out of the store is no session of it
    return storeRelative(realpathSync(root), realpathSync(session), paths)?.length === depth ? session : null;
  } catch { return null; }
}

/**
 * Where a store keeps its sessions and terminal breadcrumbs: `<agentDir>/sessions/<cwd>/<id>.jsonl`
 * and `<agentDir>/terminal-sessions` by default. omp can move either (omp.ts ompStoreLayout).
 */
export interface StoreRoots { sessions: string; terminalSessions: string; depth: 1 | 2 }

const defaultStoreRoots = (agentDir: string): StoreRoots =>
  ({ sessions: join(agentDir, "sessions"), terminalSessions: join(agentDir, "terminal-sessions"), depth: 2 });

/**
 * Validate the shared native breadcrumb under the store's terminal sessions (an agent directory's
 * own, or the roots given) and reject stale leftovers.
 */
export function terminalBreadcrumb(store: string | StoreRoots, cwd: string, terminalId: string, startedAt: number): string | null {
  if (!/^(?:pts-\d+|tty[\w-]+|tmux-%\d+)$/.test(terminalId) || !Number.isFinite(startedAt)) return null;
  const roots = typeof store === "string" ? defaultStoreRoots(store) : store;
  try {
    const marker = join(roots.terminalSessions, terminalId);
    const stat = statSync(marker);
    if (!stat.isFile() || stat.size > 8192 || stat.mtimeMs < startedAt - 1000) return null;
    const [savedCwd, savedPath] = readFileSync(marker, "utf8").split("\n");
    if (!savedCwd || !savedPath || realpathSync(savedCwd) !== realpathSync(cwd)) return null;
    // omp writes a relative session directory as given, relative to a directory nothing proves
    if (!nodePath.isAbsolute(savedPath)) return null;
    const root = realpathSync(roots.sessions);
    const saved = realpathSync(savedPath);
    if (!statSync(saved).isFile()) return null;
    const path = gjcSessionFile(root, saved, nodePath, roots.depth);
    if (!path) return null;
    const headerCwd = transcriptCwd(path);
    return headerCwd && realpathSync(headerCwd) === realpathSync(cwd) ? path : null;
  } catch { return null; }
}

/**
 * The transcript an agent's processes show, from its store's `roots` (GJC and omp lay theirs out
 * alike): an exact open transcript first, then the terminal-scoped breadcrumb written
 * during the process's lifetime. A directory descriptor or cwd proves only the store, not the
 * active session; never infer ownership from cwd or session recency. `path` is null unless
 * exactly one transcript qualifies; `found` says how many did. `environOf` supplies a process's
 * environment already read elsewhere, so none is read here; undefined for a pid reads it.
 */
export function heldTranscript(roots: StoreRoots, cwd: string, pids: readonly number[], environOf?: (pid: number) => readonly string[] | null | undefined): { path: string | null; found: number } {
  let root: string;
  try { root = realpathSync(roots.sessions); }
  catch { return { path: null, found: 0 }; }
  const open = new Set<string>();
  const breadcrumbs = new Set<string>();
  for (const pid of pids) {
    const terminal = gjcTerminal(pid, environOf?.(pid));
    if (terminal) {
      const path = terminalBreadcrumb(roots, cwd, terminal.id, terminal.startedAt);
      if (path) breadcrumbs.add(path);
    }
    let fds: string[] = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { /* macOS uses the native breadcrumb */ }
    for (const fd of fds) {
      try {
        const file = realpathSync(readlinkSync(`/proc/${pid}/fd/${fd}`));
        const target = statSync(file).isFile() ? gjcSessionFile(root, file, nodePath, roots.depth) : null;
        if (target && transcriptCwd(target) === cwd) open.add(target);
      } catch { /* closed, deleted or unreadable descriptor */ }
    }
  }
  const candidates = open.size > 0 ? open : breadcrumbs;
  return { path: candidates.size === 1 ? [...candidates][0]! : null, found: candidates.size };
}

type GjcPaneProcessInfo = { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown; argv?: unknown }[] } };
type GjcProcessIdentity = { pid: number; birth: number };

export type GjcTranscriptOptions = {
  platform?: string;
  processInfo?: (paneId: string) => Promise<GjcPaneProcessInfo | null>;
  /** herdr's answer the caller's poll already read for this pane: it stands in for the first read only, the
   * check after the binding is read always asks again */
  known?: GjcPaneProcessInfo["process_info"] | null;
  processBirth?: (pid: number) => number | null | Promise<number | null>;
  readProcessTable?: () => Promise<ProcessRow[]>;
  now?: () => number;
};

function sameBirth(left: number, right: number, platform: string): boolean {
  return platform === "darwin" ? Math.abs(left - right) <= 1000 : left === right;
}

async function foregroundProcesses(
  info: GjcPaneProcessInfo | null,
  platform: string,
  options: GjcTranscriptOptions,
  fresh: boolean,
  freshAfter = -1,
): Promise<GjcProcessIdentity[] | null> {
  const processInfo = info?.process_info;
  if (!processInfo) return null;
  if (platform === "win32") {
    const readTable = options.readProcessTable ?? windowsProcessTable;
    const table = fresh
      ? () => freshProcessTable(readTable, freshAfter)
      : () => recentProcessTable(readTable, (options.now ?? Date.now)());
    const process = await gjcPidUnderShell(processInfo.shell_pid, platform, table);
    if (process === undefined) return null;
    if (process === null) return [];
    if (!Number.isSafeInteger(process.started) || process.started === null || process.started <= 0) return null;
    return [{ pid: process.pid, birth: process.started }];
  }

  const foreground = processInfo.foreground_processes;
  if (!Array.isArray(foreground)) return null;
  const identities = new Map<number, number>();
  // awaited: GJC discovery runs this for every snapshot, and macOS reads a start with `ps` (#1545)
  const birthOf = options.processBirth ?? processStartedAtAsync;
  for (const process of foreground) {
    const argv = Array.isArray(process.argv) ? process.argv.filter((arg): arg is string => typeof arg === "string") : [];
    if (!isGjcProcess(argv)) continue;
    if (typeof process.pid !== "number" || !Number.isSafeInteger(process.pid) || process.pid <= 0) return null;
    const birth = await birthOf(process.pid);
    if (birth === null || !Number.isSafeInteger(birth) || birth <= 0) return null;
    const previous = identities.get(process.pid);
    if (previous !== undefined && !sameBirth(previous, birth, platform)) return null;
    identities.set(process.pid, birth);
  }
  return [...identities].map(([pid, birth]) => ({ pid, birth }));
}

function sameProcess(left: GjcProcessIdentity, right: GjcProcessIdentity, platform: string): boolean {
  return left.pid === right.pid && sameBirth(left.birth, right.birth, platform);
}

function sameNativeVersion(left: NonNullable<ReturnType<typeof readGjcNativeBinding>>, right: NonNullable<ReturnType<typeof readGjcNativeBinding>>): boolean {
  if (left.pid !== right.pid || left.processStartedAt !== right.processStartedAt
    || left.instanceId !== right.instanceId || left.sequence !== right.sequence) return false;
  if (left.session === null || right.session === null) return left.session === right.session;
  return left.session.id === right.session.id && left.session.path === right.session.path && left.session.cwd === right.session.cwd;
}

/** Resolve only the exact, live GJC process's unexpired native lifecycle record. */
export function gjcTranscriptForPane(
  paneId: string,
  cwd: string,
  home = userHome(),
  options: GjcTranscriptOptions = {},
): Promise<string | null> {
  const token: LookupToken = { cancelled: false };
  const lookups = lookupsInFlight.get(paneId) ?? new Set<LookupToken>();
  lookups.add(token);
  lookupsInFlight.set(paneId, lookups);
  return lookupNativeTranscript(paneId, cwd, home, options, token).finally(() => {
    lookups.delete(token);
    if (lookups.size === 0 && lookupsInFlight.get(paneId) === lookups) lookupsInFlight.delete(paneId);
  });
}

async function lookupNativeTranscript(
  paneId: string,
  cwd: string,
  home: string,
  options: GjcTranscriptOptions,
  token: LookupToken,
): Promise<string | null> {
  try {
    if (!nodePath.isAbsolute(cwd) || !nodePath.isAbsolute(home) || token.cancelled) return null;
    const platform = options.platform ?? process.platform;
    const readProcessInfo = options.processInfo ?? ((id: string) => herdrRpc<GjcPaneProcessInfo>(
      "pane.process_info", { pane_id: id },
    ).catch(() => null));
    const initialInfo = options.known !== undefined ? (options.known === null ? null : { process_info: options.known }) : await readProcessInfo(paneId);
    if (!initialInfo || token.cancelled) return null;
    const initial = await foregroundProcesses(initialInfo, platform, options, false);
    if (!initial || initial.length !== 1 || token.cancelled) return null;
    const freshAfter = freshReads;
    const owner = initial[0]!;

    const binding = readGjcNativeBinding(home, owner.pid, options.now?.());
    if (!binding || !sameBirth(binding.processStartedAt, owner.birth, platform) || !binding.session || token.cancelled) return null;
    const path = validateGjcNativeTranscript(binding, cwd, home, platform);
    if (!path || token.cancelled) return null;

    const finalInfo = await readProcessInfo(paneId);
    if (!finalInfo || token.cancelled) return null;
    const final = await foregroundProcesses(finalInfo, platform, options, true, freshAfter);
    if (!final || final.length !== 1 || !sameProcess(owner, final[0]!, platform) || token.cancelled) return null;

    const current = readGjcNativeBinding(home, owner.pid, options.now?.());
    if (!current || !sameBirth(current.processStartedAt, final[0]!.birth, platform) || !sameNativeVersion(binding, current) || token.cancelled) return null;
    const currentPath = validateGjcNativeTranscript(current, cwd, home, platform);
    if (currentPath !== path || token.cancelled) return null;
    return currentPath;
  } catch {
    return null;
  }
}
