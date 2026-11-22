import { readFileSync } from "node:fs";
import { darwinStartTime } from "./darwin-process.ts";

/**
 * The kernel's own start on macOS, to the millisecond, read fresh on every call (a live PID may belong
 * to a replacement process) and without a child process: a `ps` here held the event loop (#1404).
 */
function darwinStart(pid: number): number | null {
  try {
    const micros = darwinStartTime(pid);
    return micros === null ? null : Number(micros / 1000n);
  } catch {
    return null;
  }
}

/**
 * When a process started, in ms since the epoch: Linux counts it in /proc (USER_HZ
 * ticks after boot); macOS has no /proc, so there the kernel's process record tells it
 * (sysctl). null where neither answers.
 */
export function processStartedAt(pid: number): number | null {
  if (process.platform === "darwin") return darwinStart(pid);
  return linuxBirth(pid);
}

/** Linux: /proc/stat's `btime` and the start's ticks after boot. */
function linuxBirth(pid: number): number | null {
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * What tells one process from another on every read, however the wall clock moves: Linux's start in
 * ticks after boot (`btime`, and so processStartedAt, follows a clock that is set later), macOS's
 * kernel start record. null where neither answers.
 */
export function processStartIdentity(pid: number): number | null {
  if (process.platform === "darwin") return darwinStart(pid);
  if (process.platform !== "linux") return null;
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

/** Whether `pid` names a running process: signal 0 checks without sending anything, and a refusal means it runs. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * processStartedAt for a caller that awaits it: the same reading (Linux's /proc birth; macOS's kernel record),
 * which no platform needs a child process for any more (#1404). null where neither answers.
 */
export async function processStartedAtAsync(pid: number): Promise<number | null> {
  return processStartedAt(pid);
}

/** Where no start time is known (Windows), null. */
export async function processStartUpperBoundAsync(pid: number): Promise<number | null> {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  return processStartUpperBound(pid);
}

/** An upper bound for comparing a new thread's timestamp, without btime's whole-second loss. */
export function processStartUpperBound(pid: number): number | null {
  if (process.platform !== "linux") {
    const started = processStartedAt(pid);
    return started === null ? null : started + 1000;
  }
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    // uptime and start ticks truncate to 10ms. Reading the wall clock last and adding
    // one tick bounds the process start from above, rather than admitting older threads.
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? Date.now() - uptime * 1000 + ticks * 10 + 10 : null;
  } catch { return null; }
}

/**
 * Linux: the boot as the wall clock less the uptime, then the start's ticks, each to 10 ms: close to
 * the real start, but a little different on each read, so never an identity. The wall clock is read
 * first: the uptime read after it is at most one tick late.
 */
function linuxReadStart(pid: number): number | null {
  try {
    const now = Date.now();
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? now - uptime * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * A time no later than the process started, in ms since the epoch: what a thread begun since
 * must be no older than. Codex 0.163 creates its thread as its process starts, often in the same
 * millisecond tick on Linux and always in the same second on macOS; the bound from
 * above (processStartUpperBound, still what a send's process check compares) left such a thread
 * out, and two Codex panes of one directory with short answers both said they could not tell. An older thread let in with it makes two begun
 * since, and two tell nothing.
 */
export function processStartLowerBound(pid: number): number | null {
  if (process.platform === "darwin") return darwinStart(pid);
  if (process.platform !== "linux") return null;
  // the earlier of both readings, less one tick: no later than the real start (the uptime's), nor
  // than the start processStartedAt tells (btime's), so a thread made as the process starts is in
  const starts = [linuxBirth(pid), linuxReadStart(pid)].filter((start): start is number => start !== null);
  return starts.length === 0 ? null : Math.min(...starts) - 10;
}
