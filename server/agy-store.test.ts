import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAgyProcessName,
  resetWindowsScanCacheForTest,
  type RestartManagerApi,
  windowsHeldPaths,
  windowsHolders,
  windowsLockCandidates,
} from "./agy-store.ts";

it("expires singleton evidence and reconciles a newer ambiguous scan", async () => {
  resetWindowsScanCacheForTest();
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    let both = false;
    const holders = (path: string) => path === "A" || both ? [4242] : [];
    const candidates = () => ["A", "B"];
    expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["A"]);
    both = true;
    now = 6_000;
    // Another pane completes a scan before the original pane resolves again.
    await windowsHeldPaths(4243, holders, candidates);
    expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["A", "B"]);
    now = 12_000;
    expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["A", "B"]);
  } finally { Date.now = realNow; }
});

it("re-validates a resolved lock with one call per refresh and rescans within a minute for a second lock", async () => {
  resetWindowsScanCacheForTest();
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    let both = false;
    const calls: string[] = [];
    const holders = (path: string) => { calls.push(path); return path === "A" || both ? [4242] : []; };
    const candidates = () => ["A", "B"];
    expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["A"]);
    for (now = 6_000; now < 60_000; now += 6_000) {
      calls.length = 0;
      expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["A"]);
      expect(calls).toEqual(["A"]);
    }
    both = true;
    now = 61_000;
    expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["A", "B"]);
  } finally { Date.now = realNow; }
});

it("keeps each unresolved pid's backoff while other panes scan in between", async () => {
  resetWindowsScanCacheForTest();
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const scans: number[] = [];
    const holders = (path: string) => { if (path === "A") scans.push(now); return []; };
    // two panes without a lock poll in turn every six seconds
    for (now = 0; now <= 120_000; now += 6_000) await windowsHeldPaths(now % 12_000 === 0 ? 4242 : 4243, holders, () => ["A", "B"]);
    expect(scans.length).toBeLessThan(15);
  } finally { Date.now = realNow; }
});

it("proves nothing from a scan whose owners moved before they were confirmed", async () => {
  resetWindowsScanCacheForTest();
  let bCalls = 0, moved = false;
  // the pid holds A and B; B's hold moves to C after the pass read C and before B is confirmed
  const holders = (path: string) => {
    if (path === "B" && ++bCalls === 2) moved = true;
    return path === "A" || (path === "B" && !moved) || (path === "C" && moved) ? [4242] : [];
  };
  expect(await windowsHeldPaths(4242, holders, () => ["A", "B", "C"])).not.toHaveLength(1);
  expect(await windowsHeldPaths(4242, holders, () => ["A", "B", "C"])).not.toHaveLength(1);
});

it("backs off a pid whose lock keeps changing hands during every scan", async () => {
  resetWindowsScanCacheForTest();
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const scans: number[] = [];
    let bCalls = 0;
    // A stays held; B answers held and then free, so every pass sees its owners move
    const holders = (path: string) => {
      if (path === "A") scans.push(now);
      return path === "A" || (path === "B" && ++bCalls % 2 === 1) ? [4242] : [];
    };
    for (now = 0; now <= 120_000; now += 6_000) expect(await windowsHeldPaths(4242, holders, () => ["A", "B"])).toEqual([]);
    // the 5, 10, 20, 40, 60 second schedule, read on a six-second poll
    expect([...new Set(scans)]).toEqual([0, 6_000, 18_000, 42_000, 84_000]);
  } finally { Date.now = realNow; }
});

for (const recovery of ["a new lock file", "another pane's scan"]) {
  it(`starts the backoff over after a moving lock settles through ${recovery}`, async () => {
    resetWindowsScanCacheForTest();
    const realNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      let moving = true, aCalls = 0, active = "";
      let paths = ["A", "B"];
      const holders = (path: string) => moving && path === "A" ? (++aCalls % 2 ? [4242] : []) : path === active ? [4242] : [];
      const candidates = () => paths;
      // the moving lock pushes the pid's backoff up to its 60-second cap
      for (now of [0, 5_000, 15_000, 35_000, 75_000]) expect(await windowsHeldPaths(4242, holders, candidates)).toEqual([]);
      moving = false;
      now = 76_000;
      if (recovery === "a new lock file") {
        paths = ["A", "B", "C"];
        expect(await windowsHeldPaths(4242, holders, candidates)).toEqual([]);
        active = "C";
        now = 82_000;
        expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["C"]);
      } else {
        active = "A";
        await windowsHeldPaths(4243, holders, candidates);
        expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["A"]);
        active = "B";
        now = 77_000;
        expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["B"]);
      }
    } finally { Date.now = realNow; }
  });
}

it("proves nothing from a scan in which a holder query failed", async () => {
  resetWindowsScanCacheForTest();
  const failing: RestartManagerApi = {
    symbols: {
      RmStartSession: (session: Buffer) => { session.writeUInt32LE(1, 0); return 0; },
      RmRegisterResources: () => 0,
      RmGetList: () => 29, // ERROR_WRITE_FAULT
      RmEndSession: () => 0,
    },
  };
  expect(windowsHolders("B", failing)).toBeNull();
  expect(await windowsHeldPaths(4242, (path) => path === "A" ? [4242] : windowsHolders(path, failing), () => ["A", "B"])).toEqual([]);
});

it("does not accept singleton evidence from an overflowing candidate listing", async () => {
  resetWindowsScanCacheForTest();
  const root = mkdtempSync(join(tmpdir(), "agy-overflow-"));
  mkdirSync(join(root, "presence"));
  try {
    for (let i = 0; i < 4097; i += 1) {
      writeFileSync(join(root, "presence", `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}.lock`), "");
    }
    const candidates = () => windowsLockCandidates({ ANTIGRAVITY_APP_DATA_DIR: root }, root);
    // The pid holds the first and last entries; a truncated scan sees only the first.
    const names = readdirSync(join(root, "presence"));
    const held = [join(root, "presence", names[0]!), join(root, "presence", names.at(-1)!)];
    const holders = (path: string) => held.includes(path) ? [4242] : [];
    expect(await windowsHeldPaths(4242, holders, candidates)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);

for (const ambiguous of [false, true]) {
  it(`caps steady-state ${ambiguous ? "ambiguous" : "missing"} scan backoff at 60 seconds`, async () => {
    resetWindowsScanCacheForTest();
    const realNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const scans: number[] = [];
      const candidates = () => ["A", "B"];
      const holders = (path: string) => {
        if (path === "A") scans.push(now);
        return ambiguous ? [4242] : [];
      };
      // A poll every six seconds, driven entirely by the controlled clock.
      for (now = 0; now <= 204_000; now += 6_000) await windowsHeldPaths(4242, holders, candidates);
      // Ambiguous results confirm each held path after each scan as well.
      expect([...new Set(scans)]).toEqual([0, 6_000, 18_000, 42_000, 84_000, 144_000, 204_000]);
    } finally { Date.now = realNow; }
  });

  it(`backs off repeated ${ambiguous ? "ambiguous" : "missing"} holds and resets on listing or pid change`, async () => {
    resetWindowsScanCacheForTest();
    const realNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      let calls = 0;
      let paths = ["A", "B"];
      let held = ambiguous ? ["A", "B"] : [];
      const holders = (path: string) => { calls += 1; return held.includes(path) ? [4242] : []; };
      const candidates = () => paths;
      await windowsHeldPaths(4242, holders, candidates);
      now = 6_000;
      await windowsHeldPaths(4242, holders, candidates);
      const afterRetry = calls;
      now = 12_000;
      await windowsHeldPaths(4242, holders, candidates);
      expect(calls).toBe(afterRetry);
      paths = ["A", "B", "C"];
      held = ["C"];
      expect(await windowsHeldPaths(4242, holders, candidates)).toEqual(["C"]);
      expect(calls).toBeGreaterThan(afterRetry);
      const afterChange = calls;
      now = 18_000;
      await windowsHeldPaths(4243, holders, candidates);
      expect(calls).toBeGreaterThan(afterChange);
      // With no directory change, retries remain bounded rather than stopping discovery forever.
      now = 80_000;
      const beforeDeadline = calls;
      await windowsHeldPaths(4242, holders, candidates);
      expect(calls).toBeGreaterThan(beforeDeadline);
    } finally { Date.now = realNow; }
  });
}

it("reads only presence locks as candidates, never another file beside them", () => {
  const root = mkdtempSync(join(tmpdir(), "agy-store-"));
  mkdirSync(join(root, "presence"));
  const lock = "00000000-0000-4000-8000-000000000001.lock";
  writeFileSync(join(root, "presence", lock), "");
  writeFileSync(join(root, "presence", "state.json"), "{}");
  writeFileSync(join(root, "presence", "notes.lock"), "");
  try {
    expect(windowsLockCandidates({ ANTIGRAVITY_APP_DATA_DIR: root }, root)).toEqual([join(root, "presence", lock)]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("names no candidate when the agent keeps no presence directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agy-store-"));
  try {
    expect(windowsLockCandidates({ ANTIGRAVITY_APP_DATA_DIR: root }, root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("recognizes the agent's process name as herdr reports it on this platform", () => {
  const win32 = process.platform === "win32";
  expect(isAgyProcessName(win32 ? "agy.exe" : "agy")).toBe(true);
  expect(isAgyProcessName("agy")).toBe(true);
  expect(isAgyProcessName("agyx")).toBe(false);
  expect(isAgyProcessName("bun")).toBe(false);
  expect(isAgyProcessName(undefined)).toBe(false);
  expect(isAgyProcessName("/usr/local/bin/agy")).toBe(win32);
});

it("updates held lock when the process switches from lock A to lock B on /new or /resume", async () => {
  resetWindowsScanCacheForTest();
  const pid = 4242;
  const lockA = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  const lockB = "C:\\path\\presence\\00000000-0000-4000-8000-000000000002.lock";
  let activeHolders: Record<string, number[]> = { [lockA]: [pid], [lockB]: [] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  const mockCandidates = () => [lockA, lockB];

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([lockA]);

  activeHolders = { [lockA]: [], [lockB]: [pid] };

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([lockB]);
});

it("drops held lock when the process releases its session lock without acquiring another", async () => {
  resetWindowsScanCacheForTest();
  const pid = 4242;
  const lockA = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  let activeHolders: Record<string, number[]> = { [lockA]: [pid] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  const mockCandidates = () => [lockA];

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([lockA]);

  activeHolders = { [lockA]: [] };

  expect(await windowsHeldPaths(pid, mockHolders, mockCandidates)).toEqual([]);
});

it("coalesces concurrent scans across panes without invalidating scan cache", async () => {
  resetWindowsScanCacheForTest();
  const pid1 = 4242;
  const pid2 = 4243;
  const lock1 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  const lock2 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000002.lock";
  const activeHolders: Record<string, number[]> = { [lock1]: [pid1], [lock2]: [pid2] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  let candidateCalls = 0;
  const mockCandidates = () => {
    candidateCalls += 1;
    return [lock1, lock2];
  };

  const [res1, res2] = await Promise.all([
    windowsHeldPaths(pid1, mockHolders, mockCandidates),
    windowsHeldPaths(pid2, mockHolders, mockCandidates),
  ]);

  expect(res1).toEqual([lock1]);
  expect(res2).toEqual([lock2]);
  expect(candidateCalls).toBe(1);
  expect(await windowsHeldPaths(pid1, mockHolders, mockCandidates)).toEqual([lock1]);
  expect(candidateCalls).toBe(1);
});

it("discovers a newly held lock after overlapping callers when TTL expires", async () => {
  resetWindowsScanCacheForTest();
  const pid1 = 4242;
  const pid2 = 4243;
  const pid3 = 4244;
  const lock1 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000001.lock";
  const lock2 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000002.lock";
  const lock3 = "C:\\path\\presence\\00000000-0000-4000-8000-000000000003.lock";
  let activeHolders: Record<string, number[]> = { [lock1]: [pid1], [lock2]: [pid2], [lock3]: [] };
  const mockHolders = (path: string) => activeHolders[path] ?? [];
  let candidateCalls = 0;
  const mockCandidates = () => {
    candidateCalls += 1;
    return [lock1, lock2, lock3];
  };

  const [res1, res2] = await Promise.all([
    windowsHeldPaths(pid1, mockHolders, mockCandidates),
    windowsHeldPaths(pid2, mockHolders, mockCandidates),
  ]);

  expect(res1).toEqual([lock1]);
  expect(res2).toEqual([lock2]);
  expect(candidateCalls).toBe(1);

  // New lock acquired by pid3:
  activeHolders = { [lock1]: [pid1], [lock2]: [pid2], [lock3]: [pid3] };

  // At +6 seconds, TTL expires: a new scan must run and discover lock3
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6_000;
    expect(await windowsHeldPaths(pid3, mockHolders, mockCandidates)).toEqual([lock3]);
    expect(candidateCalls).toBe(2);
  } finally {
    Date.now = realNow;
  }
});

it("retries and reallocates when RmGetList returns ERROR_MORE_DATA (234) with growing needed", () => {
  let callIndex = 0;
  const mockApi: RestartManagerApi = {
    symbols: {
      RmStartSession: (session: Buffer) => {
        session.writeUInt32LE(1234, 0);
        return 0;
      },
      RmRegisterResources: () => 0,
      RmGetList: (_handle: number, needed: Buffer, count: Buffer, list: Buffer | null) => {
        callIndex += 1;
        if (callIndex === 1) {
          needed.writeUInt32LE(1, 0);
          return 234;
        }
        if (callIndex === 2) {
          needed.writeUInt32LE(2, 0);
          return 234;
        }
        if (callIndex === 3) {
          needed.writeUInt32LE(2, 0);
          count.writeUInt32LE(2, 0);
          if (list) {
            list.writeUInt32LE(4242, 0);
            list.writeUInt32LE(4243, 668);
          }
          return 0;
        }
        return 0;
      },
      RmEndSession: () => 0,
    },
  };

  const holders = windowsHolders("C:\\path\\presence\\test.lock", mockApi);
  expect(holders).toEqual([4242, 4243]);
  expect(callIndex).toBe(3);
});
