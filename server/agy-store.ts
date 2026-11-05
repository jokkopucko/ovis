/** Agy owns one presence lock for the conversation currently displayed in this process. */
import { readdirSync, readFileSync, opendirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";

export interface AgyStore { root: string; session: string; path: string; pid: number; started: string }
const LOCK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/i;

/** Only paths held by the selected process are candidates; directory contents aren't evidence. */
export function agyStoreFromLocks(paths: readonly string[]): Pick<AgyStore, "root" | "session" | "path"> | null {
  const locks = new Set<string>();
  for (const path of paths) {
    if (basename(dirname(path)) !== "presence" || !LOCK.test(basename(path))) continue;
    try {
      const canonical = realpathSync(path);
      if (basename(dirname(canonical)) !== "presence" || !LOCK.test(basename(canonical)) || !statSync(canonical).isFile()) return null;
      locks.add(canonical);
    } catch { return null; }
  }
  if (locks.size !== 1) return null;
  const lock = [...locks][0]!;
  try {
    const root = dirname(dirname(lock));
    const session = basename(lock, ".lock");
    const path = join(root, "brain", session, ".system_generated", "logs", "transcript_full.jsonl");
    return { root, session, path };
  } catch { return null; }
}

/**
 * Windows has no `/proc` and no `lsof`, so the held locks are asked of the documented Restart
 * Manager instead: `RmGetList` names the processes using a file. Agy's presence locks are the only
 * files asked about, and a caller that cannot get an answer fails closed to the terminal.
 */
const RM_PROCESS_INFO_SIZE = 668; // RM_UNIQUE_PROCESS(12) + 256 WCHAR + 64 WCHAR + 4 x 4-byte fields
const MAX_WINDOWS_CANDIDATES = 4096;
const MAX_WINDOWS_HOLDERS = 4096;
const WINDOWS_SCAN_TTL_MS = 5_000;

/** Load rstrtmgr.dll via Bun FFI for querying file lock owners. */
const openRestartManager = () => dlopen(join(process.env["SystemRoot"] || process.env["windir"] || "C:\\Windows", "System32", "rstrtmgr.dll"), {
  RmStartSession: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
  RmRegisterResources: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
  RmGetList: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  RmEndSession: { args: [FFIType.u32], returns: FFIType.u32 },
});

/** Load kernel32.dll via Bun FFI for process inspection and handle management. */
const openKernel = () => dlopen(join(process.env["SystemRoot"] || process.env["windir"] || "C:\\Windows", "System32", "kernel32.dll"), {
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
  GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
});

let windowsApis: { restartManager: ReturnType<typeof openRestartManager>; kernel: ReturnType<typeof openKernel> } | null = null;
/** Lazily initialize and cache Win32 FFI function bindings. */
function windowsApi(): NonNullable<typeof windowsApis> {
  windowsApis ??= { restartManager: openRestartManager(), kernel: openKernel() };
  return windowsApis;
}

/** Minimal type definition for Win32 Restart Manager API symbols used by windowsHolders. */
export type RestartManagerApi = {
  symbols: {
    RmStartSession: (pSessionHandle: Buffer, dwSessionFlags: number, strSessionKey: Buffer) => number;
    RmRegisterResources: (dwSessionHandle: number, nFiles: number, rgsFilenames: Buffer, nApplications: number, rgApplications: unknown, nServices: number, rgsServiceNames: unknown) => number;
    RmGetList: (dwSessionHandle: number, pnProcInfoNeeded: Buffer, pnProcInfo: Buffer, rgAffectedApps: Buffer | null, lpdwRebootReasons: Buffer) => number;
    RmEndSession: (dwSessionHandle: number) => number;
  };
};

/**
 * Every process the Restart Manager names for this file; empty when the file is not held, null when
 * the query failed (a failed query proves nothing about who holds the file).
 */
export function windowsHolders(path: string, api?: RestartManagerApi): number[] | null {
  const restartManager = api ?? windowsApi().restartManager;
  const session = Buffer.alloc(4);
  // CCH_RM_SESSION_KEY (32) + NUL, in WCHARs = 66 bytes.
  if (restartManager.symbols.RmStartSession(session, 0, Buffer.alloc(68)) !== 0) return null;
  const handle = session.readUInt32LE(0);
  try {
    // Keep the UTF-16 path in the same allocation as the pointer array passed to the native call.
    const files = Buffer.alloc(8 + Buffer.byteLength(`${path}\0`, "utf16le"));
    files.write(`${path}\0`, 8, "utf16le");
    files.writeBigUInt64LE(BigInt(ptr(files.subarray(8))), 0);
    if (restartManager.symbols.RmRegisterResources(handle, 1, files, 0, null, 0, null) !== 0) return null;
    const needed = Buffer.alloc(4), count = Buffer.alloc(4), reasons = Buffer.alloc(4);
    let status = restartManager.symbols.RmGetList(handle, needed, count, null, reasons);
    let list: Buffer | null = null;
    let allocatedSlots = 0;
    for (let retry = 0; retry < 4 && status === 234; retry += 1) {
      const total = needed.readUInt32LE(0);
      if (total === 0 || total > MAX_WINDOWS_HOLDERS) return null;
      list = Buffer.alloc(RM_PROCESS_INFO_SIZE * total);
      allocatedSlots = total;
      count.writeUInt32LE(total, 0);
      status = restartManager.symbols.RmGetList(handle, needed, count, list, reasons);
    }
    if (status !== 0) return null;
    // a complete answer to the first call: nothing holds the file
    if (!list) return [];
    const returnedCount = Math.min(count.readUInt32LE(0), allocatedSlots);
    const owners: number[] = [];
    for (let index = 0; index < returnedCount; index += 1) owners.push(list.readUInt32LE(RM_PROCESS_INFO_SIZE * index));
    return owners;
  } finally { restartManager.symbols.RmEndSession(handle); }
}

/** Agy keeps one lock per conversation under its data dir; presence mirrors the agent's own store. */
export function windowsLockCandidates(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const presence = join(env["ANTIGRAVITY_APP_DATA_DIR"] || join(home, ".gemini", "antigravity-cli"), "presence");
  let names: string[];
  try { names = readdirSync(presence); } catch { return []; }
  const candidates = names.filter((name) => LOCK.test(name)).map((name) => join(presence, name));
  return candidates.length > MAX_WINDOWS_CANDIDATES ? [] : candidates;
}

/** `complete` is false when a holder query failed: such a pass names no pid's only lock. */
interface WindowsScan { at: number; candidates: string; owners: Map<number, string[]>; complete: boolean }
type WindowsHolders = (path: string) => number[] | null;
const holds = (getHolders: WindowsHolders, path: string, pid: number): boolean => getHolders(path)?.includes(pid) ?? false;
let windowsScan: WindowsScan | null = null;
let windowsScanning: Promise<WindowsScan> | null = null;
let windowsScanId = 0;

/** Invalidate in-flight and completed candidate scans so the next lookup rescans. */
function invalidateWindowsScan(): void {
  windowsScan = null;
  windowsScanning = null;
  windowsScanId += 1;
}

/** Reset scan and holder caches between tests. */
export function resetWindowsScanCacheForTest(): void {
  invalidateWindowsScan();
  windowsNegative.clear();
  windowsHeld.clear();
}

/**
 * One pass over the candidates, shared by every caller and every pane. Each `RmGetList` call blocks,
 * so the pass yields between them: a scan takes a few seconds without stalling the server.
 */
function windowsScanAll(
  getHolders: WindowsHolders = windowsHolders,
  getCandidates: () => string[] = windowsLockCandidates,
): Promise<WindowsScan> {
  const known = windowsScan;
  if (known && Date.now() - known.at < WINDOWS_SCAN_TTL_MS) return Promise.resolve(known);
  if (!windowsScanning) {
    const id = ++windowsScanId;
    windowsScanning = (async () => {
      const owners = new Map<number, string[]>();
      const candidates = getCandidates();
      let complete = true;
      for (const path of candidates) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (windowsScanId !== id) break;
        const holders = getHolders(path);
        if (holders === null) complete = false;
        for (const pid of holders ?? []) owners.set(pid, [...(owners.get(pid) ?? []), path]);
      }
      const scan = { at: Date.now(), candidates: JSON.stringify([...candidates].sort()), owners, complete };
      if (windowsScanId !== id) return windowsScanAll(getHolders, getCandidates);
      windowsScan = scan;
      return scan;
    })().finally(() => { windowsScanning = null; });
  }
  return windowsScanning;
}

/**
 * Unresolved pids retry at 5, 10, 20, 40, then 60 seconds while the listing stays unchanged, each
 * on its own deadline: another pane's scan in between is read, never a reason to scan again.
 */
const windowsNegative = new Map<number, { listing: string; scanAt: number; delay: number; next: number }>();

/**
 * A pid's one held lock and when a scan proved it the only one: a resolved pane costs one call per
 * refresh, and a full pass once a minute, or a newer scan from another pane, notices a second lock.
 */
const windowsHeld = new Map<number, { path: string; proven: number }>();
const WINDOWS_HELD_MAX_AGE_MS = 60_000;
function rememberHeld(pid: number, path: string, proven: number): void {
  windowsNegative.delete(pid);
  windowsHeld.set(pid, { path, proven });
  if (windowsHeld.size > 64) windowsHeld.delete(windowsHeld.keys().next().value!);
}

/** The locks this pid holds: one known path is re-validated, a new or moved session is scanned. */
export async function windowsHeldPaths(
  pid: number,
  getHolders: WindowsHolders = windowsHolders,
  getCandidates: () => string[] = windowsLockCandidates,
): Promise<string[]> {
  const known = windowsHeld.get(pid);
  if (known !== undefined) {
    const newer = windowsScan !== null && windowsScan.at > known.proven ? windowsScan.owners.get(pid) ?? [] : null;
    const stillOnly = newer === null || (newer.length === 1 && newer[0] === known.path);
    if (stillOnly && Date.now() - known.proven < WINDOWS_HELD_MAX_AGE_MS && holds(getHolders, known.path, pid)) return [known.path];
    windowsHeld.delete(pid);
    // a newer scan that disagrees already stands; otherwise the next answer needs a new pass
    if (stillOnly) invalidateWindowsScan();
  }
  if (!windowsScanning && (!windowsScan || Date.now() - windowsScan.at >= WINDOWS_SCAN_TTL_MS)) {
    const candidates = getCandidates();
    const listing = JSON.stringify([...candidates].sort());
    if (windowsScan && windowsScan.candidates !== listing) {
      invalidateWindowsScan();
      windowsNegative.clear();
    }
    const negative = windowsNegative.get(pid);
    if (negative && negative.listing === listing && Date.now() < negative.next) return [];
    getCandidates = () => candidates;
  }
  // Only a fresh, complete scan establishes singleton evidence; confirm it on every refresh.
  const seen = windowsScan?.owners.get(pid);
  if (windowsScan?.complete && Date.now() - windowsScan.at < WINDOWS_SCAN_TTL_MS && seen?.length === 1) {
    if (holds(getHolders, seen[0]!, pid)) { rememberHeld(pid, seen[0]!, windowsScan.at); return seen; }
    invalidateWindowsScan();
  }
  const scan = await windowsScanAll(getHolders, getCandidates);
  const scanned = scan.owners.get(pid) ?? [];
  const held = scanned.filter((path) => holds(getHolders, path, pid));
  // ownership moved during the pass: a lock it never saw may be held too, so nothing is proven,
  // and the pid backs off like any unresolved one instead of rescanning on every refresh
  const moved = held.length !== scanned.length;
  if (moved) invalidateWindowsScan();
  else if (held.length === 1 && scan.complete) {
    rememberHeld(pid, held[0]!, scan.at);
    return held;
  }
  const previous = windowsNegative.get(pid);
  if (previous?.scanAt !== scan.at) {
    // a changed listing starts over even when no scan was left to compare it with
    const base = previous?.listing === scan.candidates ? previous.delay : WINDOWS_SCAN_TTL_MS / 2;
    const delay = Math.min(base * 2, 60_000);
    windowsNegative.set(pid, { listing: scan.candidates, scanAt: scan.at, delay, next: scan.at + delay });
    if (windowsNegative.size > 64) windowsNegative.delete(windowsNegative.keys().next().value!);
  }
  return scan.complete && !moved ? held : [];
}

/** Stable process birth identity; elapsed-time estimates drift between reads on macOS. */
async function processIdentity(pid: number): Promise<{ started: string } | null> {
  try {
    if (process.platform === "linux") {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ");
      const ticks = fields[19];
      if (!ticks || !/^\d+$/.test(ticks)) return null;
      return { started: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}` };
    }
    if (process.platform === "darwin") {
      const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
        stdout: "pipe", stderr: "ignore", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      const started = (await new Response(child.stdout).text()).trim();
      return await child.exited === 0 && started ? { started } : null;
    }
    if (process.platform === "win32") {
      // Creation time in 100 ns ticks: a reused pid starts later, so it cannot pass for the owner.
      const { kernel } = windowsApi();
      const handle = kernel.symbols.OpenProcess(0x1000, 0, pid);
      if (handle === null || handle === undefined) return null;
      try {
        const dates = Buffer.alloc(32);
        if (!kernel.symbols.GetProcessTimes(handle, dates, dates.subarray(8), dates.subarray(16), dates.subarray(24))) return null;
        const created = dates.readBigUInt64LE(0);
        return created > 0n ? { started: `win32:${created}` } : null;
      } finally { kernel.symbols.CloseHandle(handle); }
    }
  } catch { /* gone or unreadable owner */ }
  return null;
}

/** List open file paths held by the given process id on the current platform. */
async function heldPaths(pid: number): Promise<string[]> {
  if (process.platform === "darwin") {
    const child = Bun.spawn(["/usr/sbin/lsof", "-nPbw", "-a", "-p", String(pid), "-Fn"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
    const text = await new Response(child.stdout).text();
    if (await child.exited !== 0 || text.length > 1024 * 1024) return [];
    return text.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  }
  if (process.platform === "win32") return windowsHeldPaths(pid);
  if (process.platform !== "linux") return [];
  const dir = opendirSync(`/proc/${pid}/fd`);
  const paths: string[] = [];
  try {
    let count = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > 4096) return [];
      try { paths.push(readlinkSync(`/proc/${pid}/fd/${entry.name}`)); } catch { /* closed during enumeration */ }
    }
  } finally { dir.closeSync(); }
  return paths;
}

/** herdr names the process `agy` on Unix and `agy.exe` on Windows, as it does for herdr itself. */
export function isAgyProcessName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return process.platform === "win32" ? /(?:^|[\\/])agy(?:\.exe)?$/i.test(name) : name === "agy";
}

/** Resolve the Agy session store for the given pane by matching process identity and held locks. */
export async function resolveAgyStore(pane: HerdrPane): Promise<AgyStore | null> {
  if (pane.agent !== "agy") return null;
  try {
    const info = await paneProcessInfo(pane.pane_id);
    const owners = (info?.foreground_processes ?? []).filter((p) => isAgyProcessName(p.name) && Number.isSafeInteger(p.pid) && p.pid > 1);
    if (owners.length !== 1) return null;
    const pid = owners[0]!.pid;
    const before = await processIdentity(pid);
    const store = agyStoreFromLocks(await heldPaths(pid));
    const after = await processIdentity(pid);
    return before && store && before.started === after?.started ? { ...store, pid, started: before.started } : null;
  } catch { return null; }
}

/** Check whether two AgyStore references identify the same process and session path. */
export function sameAgyStore(a: AgyStore, b: AgyStore | null): boolean {
  return b !== null && a.pid === b.pid && a.started === b.started && a.path === b.path;
}
