import { describe, expect, it } from "bun:test";
import { cpuPercent, cpuTimesOf, createSystemSampler, DISK_STALE_MS, diskOf, diskReader, type ReadPath, handleSystemRequest, parseMeminfo, parseVmStat, realIo, STALE_MS, type SystemIo } from "./system-stats.ts";

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8192000 kB
Buffers:          500000 kB
`;

// vm_stat on an Apple silicon Mac with 48 GiB (macOS 26.5), the lines parseVmStat reads among the others
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   900855.
Pages active:                                 932085.
Pages inactive:                               877074.
Pages speculative:                             53133.
Pages wired down:                             169660.
Pages purgeable:                                2550.
"Translation faults":                     3418188362.
File-backed pages:                            691408.
Anonymous pages:                             1170884.
Pages stored in compressor:                   478253.
Pages occupied by compressor:                 138348.
Swapouts:                                   12049051.
`;
const GIB = 1024 ** 3;

describe("system readings", () => {
  it("reads memory as total minus MemAvailable, so the file cache is not used memory", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ total: 16384000 * 1024, used: 8192000 * 1024 });
    expect(parseMeminfo("MemTotal: 100 kB\n")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });

  it("reads macOS memory as Activity Monitor's Memory Used: App Memory, wired and compressed", () => {
    // (anonymous 1170884 - purgeable 2550) + wired 169660 + compressor 138348, in 16 KiB pages; the file cache is left out
    expect(parseVmStat(VM_STAT, 48 * GIB)).toEqual({ total: 48 * GIB, used: 1476342 * 16384 });
    // an Intel Mac counts 4 KiB pages
    const intel = VM_STAT.replace("page size of 16384 bytes", "page size of 4096 bytes");
    expect(parseVmStat(intel, 16 * GIB)).toEqual({ total: 16 * GIB, used: 1476342 * 4096 });
  });

  it("keeps a macOS reading inside 0 and the total, and says null for one it cannot read", () => {
    const purged = VM_STAT.replace(/^Pages purgeable:\s+\d+\./m, "Pages purgeable:                             9999999.");
    expect(parseVmStat(purged, 48 * GIB)?.used).toBe((169660 + 138348) * 16384);
    expect(parseVmStat(VM_STAT, GIB)).toEqual({ total: GIB, used: GIB });
    expect(parseVmStat(VM_STAT.replace("Pages occupied by compressor", "Pages held by compressor"), 48 * GIB)).toBeNull();
    expect(parseVmStat(VM_STAT.replace("page size of 16384 bytes", "page size unknown"), 48 * GIB)).toBeNull();
    expect(parseVmStat(VM_STAT, 0)).toBeNull();
    expect(parseVmStat("", 48 * GIB)).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("reads this Mac's memory from vm_stat", async () => {
    const memory = await realIo.memory();
    expect(memory).not.toBeNull();
    expect(memory!.used).toBeGreaterThan(0);
    expect(memory!.used).toBeLessThanOrEqual(memory!.total);
  });

  it("measures CPU as the change between two readings", () => {
    const core = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
    const before = cpuTimesOf([core(100, 900), core(100, 900)]);
    const after = cpuTimesOf([core(150, 950), core(200, 900)]);
    expect(cpuPercent(before, after)).toBe(75);
    expect(cpuPercent(before, before)).toBeNull();
  });

  it("reports a disk as df does and leaves out one too small to fill up", () => {
    const gib = 1024 ** 3;
    // 100 GiB filesystem, 5 GiB reserved for root: Use% is used over used plus what a user can still fill
    const disk = diskOf("/", { bsize: 4096, blocks: (100 * gib) / 4096, bfree: (35 * gib) / 4096, bavail: (30 * gib) / 4096 });
    expect(disk).toEqual({ path: "/", used: 65 * gib, total: 95 * gib, percent: 68.4 });
    expect(diskOf("/boot", { bsize: 4096, blocks: 1000, bfree: 10, bavail: 10 })).toBeNull();
  });
});

function fakeIo(over: Partial<SystemIo> = {}) {
  let clock = 1_000_000;
  let busy = 0;
  let total = 0;
  const calls = { cpu: 0 };
  const io: SystemIo = {
    platform: "linux",
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    cpuTimes: () => { calls.cpu += 1; busy += 25; total += 100; return { busy, total }; },
    cpuCount: () => 4,
    uptime: () => 3600.4,
    loadavg: () => [0.5, 0.25, 0.125],
    memory: async () => ({ total: 1000, used: 250 }),
    disks: async () => [],
    ...over,
  };
  return { io, calls, advance: (ms: number) => { clock += ms; } };
}

describe("the sampler", () => {
  it("waits a moment on its first reading so CPU has something to compare", async () => {
    const { io } = fakeIo();
    const report = await createSystemSampler(io).read();
    expect(report.cpu_percent).toBe(25);
    expect(report.memory).toEqual({ used: 250, total: 1000, percent: 25 });
    expect(report.load).toEqual([0.5, 0.25, 0.13]);
    expect(report.uptime_s).toBe(3600);
    expect(report.cpu_count).toBe(4);
  });

  it("answers asks closer than the fresh window from one reading", async () => {
    const { io, calls, advance } = fakeIo();
    const sampler = createSystemSampler(io);
    const first = await sampler.read();
    const used = calls.cpu;
    advance(500);
    expect(await sampler.read()).toBe(first);
    expect(calls.cpu).toBe(used);
    advance(2000);
    expect((await sampler.read()).sampled_at).toBeGreaterThan(first.sampled_at);
  });

  it("shares one reading between asks that arrive together", async () => {
    const { io, calls } = fakeIo();
    const sampler = createSystemSampler(io);
    const [a, b] = await Promise.all([sampler.read(), sampler.read()]);
    expect(a).toBe(b);
    expect(calls.cpu).toBe(2);
  });

  it("says null for what a PC cannot measure, never zero", async () => {
    const { io } = fakeIo({ platform: "win32", memory: async () => null });
    const report = await createSystemSampler(io).read();
    expect(report.platform).toBe("win32");
    expect(report.load).toBeNull();
    expect(report.memory).toBeNull();
  });

  it("starts a fresh comparison after a quiet spell instead of averaging the whole spell", async () => {
    const { io, calls, advance } = fakeIo();
    const sampler = createSystemSampler(io);
    await sampler.read();
    advance(STALE_MS + 1);
    const before = calls.cpu;
    await sampler.read();
    // the first reading takes two CPU samples (baseline, then the window); a stale one does the same
    expect(calls.cpu - before).toBe(2);
    advance(5000);
    const steady = calls.cpu;
    await sampler.read();
    expect(calls.cpu - steady).toBe(1);
  });

  it("starts a fresh comparison when cores come or go", async () => {
    let cores = 4;
    const { io, calls, advance } = fakeIo({ cpuCount: () => cores });
    const sampler = createSystemSampler(io);
    await sampler.read();
    cores = 5;
    advance(5000);
    const before = calls.cpu;
    expect((await sampler.read()).cpu_count).toBe(5);
    expect(calls.cpu - before).toBe(2);
  });

  it("leaves a disk that does not answer out, answers anyway, and does not ask it again meanwhile", async () => {
    let asked = 0;
    const never = new Promise<never>(() => {});
    const { io, advance } = fakeIo({ disks: () => { asked += 1; return never; } });
    const sampler = createSystemSampler(io, { diskCapMs: 20 });
    const first = await sampler.read();
    expect(first.disks).toEqual([]);
    expect(first.memory).not.toBeNull();
    advance(5000);
    const second = await sampler.read();
    expect(second.disks).toEqual([]);
    // one read is still pending, so no second thread was spent on the stuck mount
    expect(asked).toBe(1);
  });

  it("shows the root as read now while the home folder's mount does not answer, and asks that mount once", async () => {
    const gib = 1024 ** 3;
    let rootFree = 50;
    const asked: string[] = [];
    const read: ReadPath = (path) => {
      asked.push(path);
      if (path === "/home/me") return new Promise<never>(() => {});
      return Promise.resolve({ dev: 1, numbers: { bsize: 1, blocks: 100 * gib, bfree: rootFree * gib, bavail: rootFree * gib } });
    };
    const disks = diskReader(read, () => ["/", "/home/me"], 20);
    expect((await disks()).map((disk) => [disk.path, disk.percent])).toEqual([["/", 50]]);
    rootFree = 10;
    expect((await disks()).map((disk) => [disk.path, disk.percent])).toEqual([["/", 90]]);
    expect(asked).toEqual(["/", "/home/me", "/"]);
  });

  it("stops showing the last disks once a stuck read has outlasted them", async () => {
    const disk = { path: "/", used: 5, total: 10, percent: 50 };
    let call = 0;
    const { io, advance } = fakeIo({ disks: () => { call += 1; return call === 1 ? Promise.resolve([disk]) : new Promise<never>(() => {}); } });
    const sampler = createSystemSampler(io, { diskCapMs: 20 });
    expect((await sampler.read()).disks).toEqual([disk]);
    advance(5000);
    expect((await sampler.read()).disks).toEqual([disk]);
    advance(DISK_STALE_MS);
    expect((await sampler.read()).disks).toEqual([]);
    expect(call).toBe(2);
  });

  it("keeps the last disks while one read is late, and takes the new answer when it arrives", async () => {
    const disk = { path: "/", used: 5, total: 10, percent: 50 };
    const late = Promise.withResolvers<typeof disk[]>();
    let call = 0;
    const { io, advance } = fakeIo({ disks: () => { call += 1; return call === 1 ? Promise.resolve([disk]) : late.promise; } });
    const sampler = createSystemSampler(io, { diskCapMs: 20 });
    expect((await sampler.read()).disks).toEqual([disk]);
    advance(5000);
    expect((await sampler.read()).disks).toEqual([disk]);
    late.resolve([{ ...disk, percent: 60 }]);
    // the sampler's own handler on that read was attached first, so it has run once this await returns
    await late.promise;
    advance(5000);
    expect((await sampler.read()).disks[0]?.percent).toBe(60);
  });

  it("serves GET as JSON that is never cached, and refuses writes", async () => {
    const sampler = createSystemSampler(fakeIo().io);
    const ok = await handleSystemRequest(new Request("http://x/api/system"), sampler);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await ok.json() as { cpu_count: number }).cpu_count).toBe(4);
    expect((await handleSystemRequest(new Request("http://x/api/system", { method: "POST" }), sampler)).status).toBe(405);
  });

  it("answers 404 where it has no load of its own to tell (a herdr-core machine's server on this PC)", async () => {
    const answer = await handleSystemRequest(new Request("http://x/api/system"), null);
    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: { code: "system_unavailable" } });
  });
});
