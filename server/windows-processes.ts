/**
 * What runs under a pane's shell on Windows. herdr's pane.process_info names only the shell
 * there, even while a program runs in it (live-verified, herdr 0.9.3: gjc.exe was a child of
 * the pane's powershell.exe and not in foreground_processes), because Windows has no
 * foreground process group to ask. It does give `shell_pid`, and the bridge runs on that
 * PC, so the process table answers instead.
 */
export interface ProcessRow {
  pid: number; parent: number; path: string | null; commandLine: string | null;
  /** when the process started, in ms since 1970: Windows hands a finished process's number to the next one */
  started?: number;
}

/** A Windows command line as argv: double quotes group, nothing else is special here. */
export function windowsArgv(commandLine: string): string[] {
  const words: string[] = [];
  for (const match of commandLine.matchAll(/"([^"]*)"|(\S+)/g)) words.push(match[1] ?? match[2]!);
  return words;
}

/**
 * Windows keeps a process's parent number after that parent exits, and hands
 * the number on: a process that started before the one now holding its parent's number is not its
 * child (when both starts are known), and neither is anything below it.
 */
export function descendantProcesses(rows: readonly ProcessRow[], pid: number): { pid: number; argv: string[] }[] {
  const found: { pid: number; argv: string[] }[] = [];
  const seen = new Set<number>([pid]);
  const started = new Map(rows.map((row) => [row.pid, row.started]));
  let level = [pid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const row of rows) {
      if (!level.includes(row.parent) || seen.has(row.pid)) continue;
      const parentStarted = started.get(row.parent);
      if (row.started !== undefined && parentStarted !== undefined && row.started < parentStarted) continue;
      seen.add(row.pid);
      next.push(row.pid);
      const argv = windowsArgv(row.commandLine ?? "");
      found.push({ pid: row.pid, argv: row.path ? [row.path, ...argv.slice(1)] : argv });
    }
    level = next;
  }
  return found;
}

export function descendantArgv(rows: readonly ProcessRow[], pid: number): string[][] {
  return descendantProcesses(rows, pid).map((entry) => entry.argv);
}

export function parseProcessTable(json: string): ProcessRow[] {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const pid = row["ProcessId"], parent = row["ParentProcessId"];
    if (typeof pid !== "number" || typeof parent !== "number") return [];
    const started = row["Started"];
    return [{
      pid, parent, path: typeof row["ExecutablePath"] === "string" ? row["ExecutablePath"] : null, commandLine: typeof row["CommandLine"] === "string" ? row["CommandLine"] : null,
      ...(typeof started === "number" ? { started } : {}),
    }];
  });
}

const TABLE_SCRIPT = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, @{n='Started';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress";

export async function tryWindowsProcessTable(timeoutMs = 10_000, command: string[] = ["powershell", "-NoProfile", "-NonInteractive", "-Command", TABLE_SCRIPT]): Promise<ProcessRow[] | null> {
  try {
    const probe = Bun.spawn(command, { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
    const [code, out] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
    if (code !== 0 || out.trim().length === 0) return null;
    let value: unknown;
    try { value = JSON.parse(out); } catch { return null; }
    const entries = Array.isArray(value) ? value : [value];
    const valid = entries.every((entry) => entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>).ProcessId === "number" && typeof (entry as Record<string, unknown>).ParentProcessId === "number");
    return valid ? parseProcessTable(out) : null;
  } catch { return null; }
}

export async function windowsProcessTable(timeoutMs = 10_000, command: string[] = ["powershell", "-NoProfile", "-NonInteractive", "-Command", TABLE_SCRIPT]): Promise<ProcessRow[]> {
  return await tryWindowsProcessTable(timeoutMs, command) ?? [];
}

const SHARED_TABLE_RECENT_MS = 5_000;
let sharedReads = 0;
let sharedRecentFloor = 0;
let sharedRecent: { at: number; started: number; settled: boolean; rows: Promise<ProcessRow[] | null> } | null = null;
let sharedFresh: { started: number; rows: Promise<ProcessRow[] | null> } | null = null;

export function windowsTableWatermark(): number {
  return sharedReads;
}

export function forgetWindowsProcessTable(): void {
  sharedRecent = null;
  sharedFresh = null;
  sharedRecentFloor = 0;
}

export function recentWindowsProcessTable(
  read: () => Promise<ProcessRow[] | null>,
  now = Date.now(),
  shared = true,
): { rows: Promise<ProcessRow[] | null>; cached: boolean; started: number } {
  if (shared && sharedRecent && now - sharedRecent.at < SHARED_TABLE_RECENT_MS) {
    return { rows: sharedRecent.rows, cached: sharedRecent.settled, started: sharedRecent.started };
  }
  const entry = { at: now, started: ++sharedReads, settled: false, rows: Promise.resolve().then(read) };
  if (shared) {
    sharedRecent = entry;
    void entry.rows.then((rows) => {
      entry.settled = true;
      if (rows === null || rows.length === 0) {
        sharedRecentFloor = Math.max(sharedRecentFloor, entry.started);
        if (sharedRecent === entry) sharedRecent = null;
      }
    }, () => {
      sharedRecentFloor = Math.max(sharedRecentFloor, entry.started);
      if (sharedRecent === entry) sharedRecent = null;
    });
  }
  return { rows: entry.rows, cached: false, started: entry.started };
}

export function freshWindowsProcessTableEntry(
  read: () => Promise<ProcessRow[] | null>,
  after = -1,
  shared = true,
): { rows: Promise<ProcessRow[] | null>; started: number } {
  if (shared && sharedFresh && sharedFresh.started > after) return sharedFresh;
  const entry = { started: ++sharedReads, rows: Promise.resolve().then(read) };
  if (shared) {
    sharedFresh = entry;
    const clear = () => { if (sharedFresh === entry) sharedFresh = null; };
    void entry.rows.then((rows) => {
      clear();
      if (rows !== null && rows.length > 0) {
        if (entry.started >= sharedRecentFloor && (!sharedRecent || entry.started >= sharedRecent.started)) {
          sharedRecent = { at: Date.now(), started: entry.started, settled: true, rows: Promise.resolve(rows) };
        }
      } else {
        sharedRecentFloor = Math.max(sharedRecentFloor, entry.started);
        if (sharedRecent && entry.started >= sharedRecent.started) sharedRecent = null;
      }
    }, () => {
      clear();
      sharedRecentFloor = Math.max(sharedRecentFloor, entry.started);
    });
  }
  return entry;
}

export function freshWindowsProcessTable(
  read: () => Promise<ProcessRow[] | null>,
  after = -1,
  shared = true,
): Promise<ProcessRow[] | null> {
  return freshWindowsProcessTableEntry(read, after, shared).rows;
}
