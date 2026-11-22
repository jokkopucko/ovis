/**
 * Startup ownership (supervisor.lock, the remote bridge's descriptor lock, the bridge descriptor)
 * changes only under a kernel lock on a permanent sibling file, `<lock>.guard`: flock on POSIX, a
 * LockFileEx byte lock on Windows. Both key on the opened file object, not on how its path is
 * spelled, and both kernels release the lock when its holder dies. The guard is held only around
 * synchronous code, never across an await, and its file is never deleted: a starter may hold it.
 *
 * A new owner directory is published whole: written in a private sibling, then renamed into place.
 * An empty directory is therefore what an older version (or an interrupted one) left, and is
 * reclaimed. Older versions take no guard, so an old and a new version starting at the same moment
 * for the same lock is not protected: that mixed-version case is unsupported.
 */
import { dlopen, FFIType, read } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyOwnerReplaced, newOwnerRecord, ownerGone, parseOwnerRecord, type OwnerRecord } from "./process-owner.ts";

export class OwnerGuardUnavailable extends Error {}
export class OwnerGuardBusy extends OwnerGuardUnavailable {}
export class OwnerGuardReleaseFailed extends Error {}

export interface PosixGuardCalls { flock(fd: number, operation: number): number; errno(): number; close(fd: number): void }
export interface WindowsGuardCalls {
  CreateFileW(path: Uint8Array, access: number, share: number, security: null, disposition: number, flags: number, template: null): bigint;
  LockFileEx(handle: bigint, flags: number, reserved: number, low: number, high: number, overlapped: Uint8Array): number;
  UnlockFileEx(handle: bigint, reserved: number, low: number, high: number, overlapped: Uint8Array): number;
  CloseHandle(handle: bigint): number;
  GetLastError(): number;
}

export const guardLibrary: { path: string; posix?(calls: PosixGuardCalls): PosixGuardCalls; windows?(calls: WindowsGuardCalls): WindowsGuardCalls } = {
  path: process.platform === "darwin" ? "libSystem.B.dylib" : process.platform === "win32" ? "kernel32.dll" : "libc.so.6",
};

const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8, EINTR = 4;
/** what flock sets when LOCK_NB finds the lock held (EWOULDBLOCK, which is EAGAIN) */
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
const GENERIC_READ_WRITE = 0xc000_0000, FILE_SHARE_READ_WRITE = 3, OPEN_ALWAYS = 4, FILE_ATTRIBUTE_NORMAL = 0x80, LOCKFILE_EXCLUSIVE_LOCK = 2;
const LOCKFILE_FAIL_IMMEDIATELY = 1, ERROR_LOCK_VIOLATION = 33;
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;

const flockSymbol = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const errnoSymbol = { args: [], returns: FFIType.ptr } as const;
function posixLibrary(path: string): Omit<PosixGuardCalls, "close"> {
  const { symbols } = process.platform === "darwin"
    ? dlopen(path, { flock: flockSymbol, __error: errnoSymbol })
    : dlopen(path, { flock: flockSymbol, __errno_location: errnoSymbol });
  const location = "__error" in symbols ? symbols.__error : symbols.__errno_location;
  return {
    flock: (fd, operation) => symbols.flock(fd, operation),
    errno: () => { const at = location(); return at === null ? -1 : read.i32(at, 0); },
  };
}
function windowsLibrary(path: string) {
  return dlopen(path, {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
    LockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UnlockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
}
const libraries = new Map<string, ReturnType<typeof posixLibrary> | ReturnType<typeof windowsLibrary>>();
function library() {
  const path = guardLibrary.path;
  let loaded = libraries.get(path);
  if (!loaded) {
    try { loaded = process.platform === "win32" ? windowsLibrary(path) : posixLibrary(path); }
    catch (error) { throw new OwnerGuardUnavailable(`the file lock could not be loaded from ${path}: ${error instanceof Error ? error.message : error}`); }
    libraries.set(path, loaded);
  }
  return loaded;
}

const describeError = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));

function lockGuard(path: string, wait = true, shared = false): () => void {
  if (process.platform === "win32") {
    const loaded: WindowsGuardCalls = (library() as ReturnType<typeof windowsLibrary>).symbols;
    const calls = guardLibrary.windows ? guardLibrary.windows(loaded) : loaded;
    const handle = calls.CreateFileW(Buffer.from(`${path}\0`, "utf16le"), GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
    if (handle === INVALID_HANDLE) throw new OwnerGuardUnavailable(`${path} could not be opened (error ${calls.GetLastError()})`);
    const overlapped = new Uint8Array(32);
    if (!calls.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | (wait ? 0 : LOCKFILE_FAIL_IMMEDIATELY), 0, 1, 0, overlapped)) {
      const code = calls.GetLastError();
      const closed = calls.CloseHandle(handle) ? "" : `; closing it failed too (error ${calls.GetLastError()})`;
      if (!wait && code === ERROR_LOCK_VIOLATION) throw new OwnerGuardBusy(`${path} is held by another process${closed}`);
      throw new OwnerGuardUnavailable(`${path} could not be locked (error ${code})${closed}`);
    }
    return () => {
      const failures: string[] = [];
      if (!calls.UnlockFileEx(handle, 0, 1, 0, overlapped)) failures.push(`unlocking failed (error ${calls.GetLastError()})`);
      // closing releases the byte range even if the unlock failed, so it is always attempted
      if (!calls.CloseHandle(handle)) failures.push(`closing failed (error ${calls.GetLastError()})`);
      if (failures.length) throw new OwnerGuardReleaseFailed(`${path} was not released cleanly: ${failures.join("; ")}`);
    };
  }
  const loaded: PosixGuardCalls = { ...(library() as ReturnType<typeof posixLibrary>), close: closeSync };
  const calls = guardLibrary.posix ? guardLibrary.posix(loaded) : loaded;
  let fd: number;
  // never through a link: a guard planted as one would make this create, and lock, a file elsewhere
  try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); }
  catch (error) { throw new OwnerGuardUnavailable(`${path} could not be opened: ${describeError(error)}`); }
  for (;;) {
    if (calls.flock(fd, (shared ? LOCK_SH : LOCK_EX) | (wait ? 0 : LOCK_NB)) === 0) break;
    const code = calls.errno();
    if (code === EINTR) continue;
    let closed = "";
    try { calls.close(fd); } catch (error) { closed = `; closing it failed too (${describeError(error)})`; }
    if (!wait && code === EWOULDBLOCK) throw new OwnerGuardBusy(`${path} is held by another process${closed}`);
    throw new OwnerGuardUnavailable(`${path} could not be locked (errno ${code})${closed}`);
  }
  return () => {
    const failures: string[] = [];
    if (calls.flock(fd, LOCK_UN) !== 0) failures.push(`unlocking failed (errno ${calls.errno()})`);
    // closing releases the lock even if the unlock failed, so it is always attempted
    try { calls.close(fd); } catch (error) { failures.push(`closing failed (${describeError(error)})`); }
    if (failures.length) throw new OwnerGuardReleaseFailed(`${path} was not released cleanly: ${failures.join("; ")}`);
  };
}

export function guardPath(lockPath: string): string { return `${lockPath}.guard`; }

/**
 * Holds the file `path` (made 0600 where absent, never through a link) for the rest of this process, POSIX
 * only: `shared` beside other shared holders, `exclusive` alone. The
 * kernel drops the hold when the process ends, however it ends, so a killed holder keeps nobody out.
 */
export function holdForLife(path: string, kind: "shared" | "exclusive"): () => void {
  return lockGuard(path, false, kind === "shared");
}

export function withOwnerGuard<T>(lockPath: string, fn: () => T, { wait = true }: { wait?: boolean } = {}): T {
  const release = lockGuard(guardPath(lockPath), wait);
  let result: T;
  try { result = fn(); }
  catch (error) {
    try { release(); }
    catch (failed) {
      throw new OwnerGuardReleaseFailed(`${(failed as Error).message}, after: ${error instanceof Error ? error.message : error}`, { cause: error });
    }
    throw error;
  }
  release();
  return result;
}

interface OwnerSample { directory: string | null; pid: string | null; owner: string | null; recordedAt: number | null; unreadable: boolean }

/** A directory's identity: a removed directory's inode number is often handed to the next one, so its change time goes along. */
function directoryIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.ctimeMs}`;
}
function readOptional(path: string): { text: string | null; ok: boolean } {
  try { return { text: readFileSync(path, "utf8"), ok: true }; }
  catch (error) { return { text: null, ok: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
}
function sample(lock: string): OwnerSample {
  let directory: string;
  try { directory = directoryIdentity(lock); }
  catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { directory: null, pid: null, owner: null, recordedAt: null, unreadable: !absent };
  }
  const pid = readOptional(join(lock, "pid")), owner = readOptional(join(lock, "owner.json"));
  let recordedAt: number | null = null;
  try { recordedAt = statSync(join(lock, "pid")).mtimeMs; } catch {}
  return { directory, pid: pid.text, owner: owner.text, recordedAt, unreadable: !pid.ok || !owner.ok };
}
const same = (a: OwnerSample, b: OwnerSample) =>
  a.directory === b.directory && a.pid === b.pid && a.owner === b.owner && a.recordedAt === b.recordedAt && a.unreadable === b.unreadable;

function owner(state: OwnerSample): { pid: number; record: OwnerRecord | null } | null {
  if (state.pid === null || !/^\d+$/.test(state.pid.trim())) return null;
  const pid = Number(state.pid.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const record = state.owner === null ? null : parseOwnerRecord(state.owner);
  return { pid, record: record?.pid === pid ? record : null };
}

type Verdict = "absent" | "stale" | "live";
function verdict(state: OwnerSample): Verdict {
  if (state.directory === null) return state.unreadable ? "live" : "absent";
  if (state.unreadable) return "live";
  if (state.pid === null && state.owner === null) return "stale";
  const named = owner(state);
  if (!named || (state.owner !== null && parseOwnerRecord(state.owner) === null)) return "live";
  if (named.record?.birth) return ownerGone(named.record) ? "stale" : "live";
  return ownerGone({ pid: named.pid }) || (state.recordedAt !== null && legacyOwnerReplaced(named.pid, state.recordedAt)) ? "stale" : "live";
}

function describe(lock: string, state: OwnerSample): string {
  if (state.directory === null) return state.unreadable ? `lock ${lock}, unreadable` : `lock ${lock}, no owner`;
  if (state.pid === null && state.owner === null && !state.unreadable) return `lock ${lock}, record-less`;
  const named = owner(state);
  if (!named || state.unreadable) return `lock ${lock}, unknown owner`;
  return named.record ? `lock ${lock}, owner pid ${named.pid} generation ${named.record.generation}` : `lock ${lock}, owner pid ${named.pid}`;
}

export function liveOwner(lock: string): string | null {
  const state = sample(lock);
  return verdict(state) === "live" ? describe(lock, state) : null;
}

const RELEASE_WAIT_MS = 5_000;

export interface OwnerLockHooks { observed?(): void; locked?(): void; validated?(): void; staged?(staging: string): void }
export interface OwnerLease { record: OwnerRecord; release(): void; amend(write: (directory: string) => void): void }

/** Nothing is signalled beyond signal 0. */
export function acquireOwnerDirectory(lock: string, errors: { running: string; starting: string }, hooks: OwnerLockHooks = {}, { wait = true }: { wait?: boolean } = {}): OwnerLease {
  const seen = sample(lock);
  if (verdict(seen) === "live") throw new Error(`${errors.running} (${describe(lock, seen)})`);
  hooks.observed?.();
  const record = newOwnerRecord();
  let published: string;
  try {
    published = withOwnerGuard(lock, () => {
      hooks.locked?.();
      const now = sample(lock);
      if (!same(now, seen) || verdict(now) === "live") throw new Error(`${errors.starting} (${describe(lock, now)})`);
      hooks.validated?.();
      const staging = `${lock}.tmp-${randomBytes(8).toString("hex")}`;
      mkdirSync(staging, { mode: 0o700 });
      try {
        writeFileSync(join(staging, "pid"), String(record.pid), { mode: 0o600 });
        writeFileSync(join(staging, "owner.json"), JSON.stringify(record), { mode: 0o600 });
        hooks.staged?.(staging);
        if (now.directory !== null) rmSync(lock, { recursive: true });
        renameSync(staging, lock);
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      return directoryIdentity(lock);
    }, { wait });
  } catch (error) {
    if (error instanceof OwnerGuardUnavailable) throw new Error(`${errors.starting} (${describe(lock, seen)}; ${error.message})`);
    if (error instanceof OwnerGuardReleaseFailed) throw new Error(`${errors.starting} (lock ${lock}; ${error.message})`, { cause: error });
    throw error;
  }
  return {
    record,
    release() {
      const deadline = Date.now() + RELEASE_WAIT_MS;
      for (;;) {
        try {
          withOwnerGuard(lock, () => {
            const now = sample(lock);
            if (now.directory === published && now.owner !== null && parseOwnerRecord(now.owner)?.generation === record.generation) rmSync(lock, { recursive: true, force: true });
          }, { wait });
          return;
        } catch (error) {
          if (error instanceof OwnerGuardBusy && Date.now() < deadline) { Bun.sleepSync(25); continue; }
          console.error(`Releasing the startup lock ${lock} failed: ${error instanceof Error ? error.message : error}`);
          return;
        }
      }
    },
    amend(write) {
      const deadline = Date.now() + RELEASE_WAIT_MS;
      for (;;) {
        try {
          withOwnerGuard(lock, () => {
            const now = sample(lock);
            if (now.directory !== published || now.owner === null || parseOwnerRecord(now.owner)?.generation !== record.generation) throw new Error(`the startup lock ${lock} is no longer this process's (${describe(lock, now)})`);
            write(lock);
            published = directoryIdentity(lock);
          }, { wait });
          return;
        } catch (error) {
          if (error instanceof OwnerGuardBusy && Date.now() < deadline) { Bun.sleepSync(25); continue; }
          throw error;
        }
      }
    },
  };
}
