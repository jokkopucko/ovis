/**
 * What this PC says about its own load: CPU, memory, load average and the disks that hold the user's
 * files. It feeds the PC header in the sidebar (GET /api/system), and a remote
 * PC answers the same route through its bridge.
 *
 * Nothing runs in the background. A reading is taken when a client asks, from counters the kernel
 * keeps anyway: CPU is the change since the previous reading, so the first
 * ask waits a moment (FIRST_WINDOW_MS) to have something to compare. Asks closer together than
 * FRESH_MS share one reading, so several browsers or tabs never shorten each other's window.
 *
 * Linux is read from /proc (memory is total minus MemAvailable, so the file cache never reads as
 * "used"). macOS memory is read from `vm_stat` as Activity Monitor's "Memory Used" (`os` counts the
 * file cache as used there). Everywhere else gets what Node's `os` can say, and the fields it cannot
 * say are null: a number that was not measured is never shown as zero.
 *
 * Limits worth knowing. In a container without lxcfs, /proc and `os` describe the host, not the
 * container's cgroup limits. libuv leaves iowait, softirq and steal out of the CPU times, so a VM
 * with a lot of steal reads a little lower than `top`. A disk that does not answer (a stuck network
 * mount) is left out after DISK_CAP_MS and is never asked again while the first ask is pending.
 */

import { readFile, stat, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, platform as osPlatform, totalmem, uptime } from "node:os";
import { parse as parsePath, resolve } from "node:path";
import type { SystemDisk, SystemReport } from "../shared/system.ts";
import { jsonResponse } from "./http.ts";

/** asks inside this window get the reading already taken */
export const FRESH_MS = 1500;
/** how long the first reading watches the counters before it answers */
export const FIRST_WINDOW_MS = 250;
/** a CPU comparison point older than this is an average of a quiet spell, not "now": start again */
export const STALE_MS = 30_000;
/** how long the disks may take before they are left out of a reading */
export const DISK_CAP_MS = 1500;
/** while a disk read is stuck, the last answer stands in for this long, then the disks are left out */
export const DISK_STALE_MS = 60_000;
/** a filesystem smaller than this (a boot partition, a tmpfs) is not a disk that fills up */
const MIN_DISK_BYTES = 1024 ** 3;
const MAX_DISKS = 4;

export interface CpuTimes { busy: number; total: number }

/** Every read the sampler makes, so tests can stand in for the machine. */
export interface SystemIo {
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  cpuTimes(): CpuTimes;
  cpuCount(): number;
  uptime(): number;
  loadavg(): [number, number, number];
  /** total and in-use bytes, or null when this PC cannot say */
  memory(): Promise<{ total: number; used: number } | null>;
  disks(): Promise<SystemDisk[]>;
}

/** The kernel's per-core counters added up: ticks spent on work and ticks in all. */
export function cpuTimesOf(list: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const { times } of list) {
    const work = times.user + times.nice + times.sys + times.irq;
    busy += work;
    total += work + times.idle;
  }
  return { busy, total };
}

/** `MemTotal` and `MemAvailable` from /proc/meminfo, in bytes; null when either is missing. */
export function parseMeminfo(text: string): { total: number; used: number } | null {
  const kib = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kib("MemTotal");
  const available = kib("MemAvailable");
  if (total === null || available === null || total <= 0) return null;
  return { total, used: Math.max(0, total - Math.min(available, total)) };
}

/**
 * macOS memory in use from `vm_stat`, as Activity Monitor's "Memory Used": App Memory (anonymous
 * pages less the purgeable ones) plus wired pages plus the pages the compressor occupies, in bytes.
 * The file cache and free pages are not used memory. Null when the page size or a count is missing.
 */
export function parseVmStat(text: string, total: number): { total: number; used: number } | null {
  const size = /page size of (\d+) bytes/.exec(text);
  const pages = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const anonymous = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable");
  const wired = pages("Pages wired down");
  const compressor = pages("Pages occupied by compressor");
  if (size === null || anonymous === null || purgeable === null || wired === null || compressor === null || !(total > 0)) return null;
  const used = (Math.max(0, anonymous - purgeable) + wired + compressor) * Number(size[1]);
  return { total, used: Math.min(used, total) };
}

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

/** One reading from two sets of counters `seconds` apart. */
export function cpuPercent(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  const busy = after.busy - before.busy;
  if (!(total > 0) || busy < 0) return null;
  return round(Math.min(100, (busy / total) * 100));
}

/** df's numbers for one filesystem; the percent is df's Use% (used over used plus what a user can still fill). */
export function diskOf(path: string, stats: { bsize: number; blocks: number; bfree: number; bavail: number }): SystemDisk | null {
  const used = (stats.blocks - stats.bfree) * stats.bsize;
  const total = used + stats.bavail * stats.bsize;
  if (!(total >= MIN_DISK_BYTES) || used < 0) return null;
  return { path, used, total, percent: round((used / total) * 100) };
}

/** What one path says: the device it is on and df's numbers for its filesystem. */
export type ReadPath = (path: string) => Promise<{ dev: number; numbers: { bsize: number; blocks: number; bfree: number; bavail: number } }>;

const readPath: ReadPath = async (path) => {
  const { dev } = await stat(path);
  return { dev, numbers: await statfs(path) };
};

const diskPaths = (): string[] => [parsePath(resolve(homedir())).root || "/", homedir()];

/**
 * The root, then the home folder when it is on another disk: at most MAX_DISKS, each filesystem
 * once. Two btrfs subvolumes have different device numbers but one pool, so the numbers decide too.
 * Each path is read on its own: one that does not answer (a stuck network mount under home) is left
 * out after `capMs` and not asked again until it does, while the other still shows, as read now.
 */
export function diskReader(read: ReadPath = readPath, paths: () => string[] = diskPaths, capMs = DISK_CAP_MS): () => Promise<SystemDisk[]> {
  const pending = new Set<string>();
  const one = (path: string) => {
    if (pending.has(path)) return Promise.resolve(null);
    pending.add(path);
    return within(read(path).finally(() => pending.delete(path)), capMs, () => null);
  };
  return async () => {
    const list = paths();
    const answers = await Promise.all(list.map(one));
    const devices = new Set<number>();
    const shapes = new Set<string>();
    const disks: SystemDisk[] = [];
    answers.forEach((answer, i) => {
      if (answer === null || devices.has(answer.dev)) return;
      const { numbers } = answer;
      const shape = `${numbers.bsize}:${numbers.blocks}:${numbers.bfree}:${numbers.bavail}`;
      if (shapes.has(shape)) return;
      const disk = diskOf(list[i]!, numbers);
      if (disk === null) return;
      devices.add(answer.dev);
      shapes.add(shape);
      disks.push(disk);
    });
    return disks.slice(0, MAX_DISKS);
  };
}

export const realIo: SystemIo = {
  platform: osPlatform(),
  now: () => Date.now(),
  // fixed wait: CPU is the change between two readings, so the first one needs a window
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  cpuTimes: () => cpuTimesOf(cpus()),
  cpuCount: () => cpus().length,
  uptime: () => uptime(),
  loadavg: () => loadavg() as [number, number, number],
  async memory() {
    if (osPlatform() === "linux") {
      try { return parseMeminfo(await readFile("/proc/meminfo", "utf8")); } catch { return null; }
    }
    // `os` counts the file cache as used on macOS, which would read as a full PC: vm_stat says what is used
    if (osPlatform() === "darwin") {
      try {
        const child = Bun.spawn(["/usr/bin/vm_stat"], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
        const text = await new Response(child.stdout).text();
        return await child.exited === 0 ? parseVmStat(text, totalmem()) : null;
      } catch { return null; }
    }
    if (osPlatform() !== "win32") return null;
    const total = totalmem();
    return total > 0 ? { total, used: Math.max(0, total - freemem()) } : null;
  },
  disks: diskReader(),
};

export interface SystemSampler { read(): Promise<SystemReport> }

/** `work`, or `fallback` once `ms` have passed: the work is left to finish on its own, never awaited again. */
function within<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((done) => {
    // fixed wait: a deadline raced against the work, which a stuck mount may never finish
    const timer = setTimeout(() => done(fallback()), ms);
    work.then((value) => { clearTimeout(timer); done(value); }, () => { clearTimeout(timer); done(fallback()); });
  });
}

export function createSystemSampler(io: SystemIo = realIo, options: { diskCapMs?: number } = {}): SystemSampler {
  const diskCapMs = options.diskCapMs ?? DISK_CAP_MS;
  let previous: { at: number; cpu: CpuTimes; cores: number } | null = null;
  let last: SystemReport | null = null;
  let inflight: Promise<SystemReport> | null = null;
  let lastDisks: { list: SystemDisk[]; at: number } | null = null;
  let diskRead: Promise<void> | null = null;

  /**
   * The disks, within diskCapMs. A disk read that has not come back is not started again: each
   * one holds a thread of the process's small pool, and a stuck mount would use them all up. Nor
   * is it waited on again, so a read that never ends holds one handler, not one per ask. The last
   * answer stands in until it comes back, for DISK_STALE_MS at most.
   */
  function disks(): Promise<SystemDisk[]> {
    const known = (): SystemDisk[] => lastDisks !== null && io.now() - lastDisks.at <= DISK_STALE_MS ? lastDisks.list : [];
    if (diskRead !== null) return Promise.resolve(known());
    const read = io.disks().then((list) => { lastDisks = { list, at: io.now() }; }, () => { /* left out; the last answer stands in */ })
      .finally(() => { diskRead = null; });
    diskRead = read;
    return within(read.then(known), diskCapMs, known);
  }

  async function take(): Promise<SystemReport> {
    const cores = io.cpuCount();
    // nothing to compare with, a comparison point from a quiet spell (that would be an average of
    // the whole spell, not "now"), or cores that came or went (their lifetime of ticks joins one
    // reading): compare over a fresh window
    if (previous === null || io.now() - previous.at > STALE_MS || previous.cores !== cores) {
      previous = { at: io.now(), cpu: io.cpuTimes(), cores };
      await io.sleep(FIRST_WINDOW_MS);
    }
    const before = previous;
    const at = io.now();
    const cpu = io.cpuTimes();
    const [memory, list] = await Promise.all([io.memory(), disks()]);
    previous = { at, cpu, cores };
    const win = io.platform === "win32";
    const load = io.loadavg();
    return {
      sampled_at: at,
      platform: io.platform === "linux" || io.platform === "darwin" || io.platform === "win32" ? io.platform : "other",
      uptime_s: Math.round(io.uptime()),
      cpu_count: cores,
      cpu_percent: cpuPercent(before.cpu, cpu),
      memory: memory === null ? null : { used: memory.used, total: memory.total, percent: round((memory.used / memory.total) * 100) },
      load: win ? null : [round(load[0], 2), round(load[1], 2), round(load[2], 2)],
      disks: list,
    };
  }

  return {
    async read() {
      if (last !== null && io.now() - last.sampled_at < FRESH_MS) return last;
      inflight ??= take().then((report) => { last = report; return report; }).finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/**
 * GET /api/system. Access is decided before this point (index.ts), as for every route. No sampler:
 * this server runs here for another machine (a herdr-core machine's server, machine-bridge.ts), so
 * this PC's load is not that machine's; it answers 404 as a server without the route does.
 */
export async function handleSystemRequest(request: Request, sampler: SystemSampler | null): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET" } }, 405);
  }
  if (sampler === null) return jsonResponse({ error: { code: "system_unavailable", message: "This machine's load is not read from here" } }, 404);
  const response = jsonResponse(await sampler.read());
  response.headers.set("cache-control", "no-store");
  return response;
}
