import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import {
  agyFreshSession,
  isAgyProcessName,
  resetWindowsScanCacheForTest,
  resolveAgyStore,
  type RestartManagerApi,
  windowsHeldPaths,
  windowsHolders,
  windowsLockCandidates,
} from "./agy-store.ts";
import * as herdr from "./herdr/client.ts";

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

/**
 * Answers `pane.process_info` for one lookup, in the order asked; `names` lists pids as Agy.
 * `asked` counts the asks of that lookup: both lookups answer null on any error, one asked too
 * often included, so only the count tells how often herdr was asked.
 */
function processInfoAnswers() {
  type Answer = () => herdr.ProcessInfo | Promise<herdr.ProcessInfo>;
  let queue: Answer[] = [];
  let asked = 0;
  const names = (pids: number[], argv = ["agy"]): Answer => () => ({ pane_id: "agy-pane", foreground_processes: pids.map((pid) => ({ pid, name: "agy", argv })) });
  const spy = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => {
    asked += 1;
    const answer = queue.shift();
    if (!answer) throw new Error("fixture: herdr was asked more often than it answers");
    return await answer();
  });
  return { names, answers: (...next: Answer[]) => { queue = next; asked = 0; }, asked: () => asked, restore: () => spy.mockRestore() };
}

/** An Agy start screen nothing was typed into yet. */
const UNUSED_START_SCREEN = [
  "       ▄▀▀▄         Antigravity CLI 1.4.4",
  "      ▀▀▀▀▀▀        user@example.test (Demo plan    )",
  "     ▀▀▀▀▀▀▀▀       Gemini 3.8 Flash (High)",
  "    ▄▀▀     ▀▀▄      /tmp/project",
  "   ▄▀▀       ▀▀▄",
  "",
  " ────────────────────────────────────────",
  " >",
  " ────────────────────────────────────────",
  " ? for shortcuts   Gemini 3.8 Flash · high",
].join("\n");

/**
 * A stand-in Agy holding the one lock, which says so itself: before its exec, the pid still shows
 * this runtime's descriptors. `first` null starts it with no lock, as an Agy that has begun no
 * conversation. `take` has it leave that lock for `next`, as `/new` does, and answers once it holds it.
 */
function standInAgy(first: string | null, next: string) {
  const script = `
    const fs = require('node:fs');
    let held = process.env.AGY_LOCK ? fs.openSync(process.env.AGY_LOCK, 'r') : null;
    process.stdout.write('up\\n');
    process.stdin.on('data', () => {
      if (held !== null) fs.closeSync(held);
      held = fs.openSync(process.env.AGY_NEXT_LOCK, 'r');
      process.stdout.write('moved\\n');
    });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, AGY_LOCK: first ?? "", AGY_NEXT_LOCK: next },
  });
  const said = child.stdout.getReader();
  const says = async (): Promise<string> => new TextDecoder().decode((await said.read()).value);
  return {
    child, says,
    take: async (): Promise<string> => {
      child.stdin.write("next\n");
      await child.stdin.flush();
      return says();
    },
  };
}

it.skipIf(process.platform === "win32")("answers a store only while the pane still names the process whose locks it reads", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-agy-recheck-")));
  const session = "00000000-0000-4000-8000-000000000001";
  const next = "00000000-0000-4000-8000-000000000002";
  const lock = (id: string) => join(root, "presence", `${id}.lock`);
  const transcript = (id: string) => join(root, "brain", id, ".system_generated", "logs", "transcript_full.jsonl");
  mkdirSync(join(root, "presence"));
  for (const id of [session, next]) writeFileSync(lock(id), "");
  const { child: agy, says, take } = standInAgy(lock(session), lock(next));
  const pane = { pane_id: "agy-pane", agent: "agy" } as HerdrPane;
  const { names, answers, asked, restore } = processInfoAnswers();
  try {
    expect(await says()).toBe("up\n");
    answers(names([agy.pid]), names([agy.pid]));
    expect(await resolveAgyStore(pane)).toMatchObject({ root, session, pid: agy.pid, path: transcript(session) });
    expect(asked()).toBe(2);
    // The pid herdr named first was another process's by the time its locks were to be read (an exited
    // Agy's pid, reused): asked again, the pane names a different process, or not this one alone.
    for (const now of [[process.pid], [agy.pid, process.pid], []]) {
      answers(names([agy.pid]), names(now));
      expect(await resolveAgyStore(pane)).toBeNull();
      expect(asked()).toBe(2);
    }
    // A lookup the first answer settles asks herdr once: a pane with no Agy, or with more than one,
    // and for the greeting, an Agy started on a conversation.
    for (const first of [[], [agy.pid, process.pid]]) {
      answers(names(first));
      expect(await resolveAgyStore(pane)).toBeNull();
      expect(asked()).toBe(1);
    }
    answers(names([agy.pid], ["agy", "--continue"]));
    expect(await agyFreshSession(pane, UNUSED_START_SCREEN)).toBeNull();
    expect(asked()).toBe(1);
    // herdr is asked again before the locks are read, so what they then show costs both asks: a
    // process with no store (this test's own), and for the greeting, one that holds a lock.
    answers(names([process.pid]), names([process.pid]));
    expect(await resolveAgyStore(pane)).toBeNull();
    expect(asked()).toBe(2);
    answers(names([agy.pid]), names([agy.pid]));
    expect(await agyFreshSession(pane, UNUSED_START_SCREEN)).toBeNull();
    expect(asked()).toBe(2);
    // The locks are the last thing read: an Agy that moved to another conversation while herdr
    // answered the second time is answered with that one, not the one it left.
    let moved = "";
    answers(names([agy.pid]), async () => {
      moved = await take();
      return names([agy.pid])();
    });
    expect(await resolveAgyStore(pane)).toMatchObject({ root, session: next, pid: agy.pid, path: transcript(next) });
    expect(moved).toBe("moved\n");
    expect(asked()).toBe(2);
    // The process is gone by the time herdr answers again with its pid: its locks cannot be read, and
    // the lookup ends there. (A pid another process took by then has locks to read: only the start
    // identity read after them refuses that one, which the order test below pins on Linux.)
    answers(names([agy.pid]), async () => {
      agy.kill();
      await agy.exited;
      return names([agy.pid])();
    });
    expect(await resolveAgyStore(pane)).toBeNull();
    expect(asked()).toBe(2);
    expect(agy.killed).toBe(true);
    // And a process whose start identity cannot be read is not asked about again.
    answers(names([agy.pid]));
    expect(await resolveAgyStore(pane)).toBeNull();
    expect(asked()).toBe(1);
  } finally {
    restore();
    agy.kill();
    await agy.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("greets a fresh Agy only while the pane still names the process that holds no lock", async () => {
  const screen = UNUSED_START_SCREEN;
  const pane = { pane_id: "agy-pane", agent: "agy" } as HerdrPane;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-agy-greeting-")));
  const lock = join(root, "presence", "00000000-0000-4000-8000-000000000003.lock");
  mkdirSync(join(root, "presence"));
  writeFileSync(lock, "");
  // a stand-in Agy that holds no lock yet, can take its first one, and can exit
  const { child: idle, says, take } = standInAgy(null, lock);
  const { names, answers, asked, restore } = processInfoAnswers();
  try {
    expect(await says()).toBe("up\n");
    // this test process holds no presence lock, as an Agy that has begun no conversation
    answers(names([process.pid]), names([process.pid]));
    expect(await agyFreshSession(pane, screen)).toStartWith(`unwritten:agy:agy-pane:${process.pid}:`);
    expect(asked()).toBe(2);
    answers(names([idle.pid]), names([idle.pid]));
    expect(await agyFreshSession(pane, screen)).toStartWith(`unwritten:agy:agy-pane:${idle.pid}:`);
    // asked again, the pane names another process, or the same pid started on a conversation
    for (const now of [names([process.pid + 1]), names([process.pid], ["agy", "--continue"])]) {
      answers(names([process.pid]), now);
      expect(await agyFreshSession(pane, screen)).toBeNull();
      expect(asked()).toBe(2);
    }
    // The locks are the last thing read here too: an Agy that took its first lock while herdr answered
    // the second time has begun a conversation, and is not greeted as one that has not.
    let moved = "";
    answers(names([idle.pid]), async () => {
      moved = await take();
      return names([idle.pid])();
    });
    expect(await agyFreshSession(pane, screen)).toBeNull();
    expect(moved).toBe("moved\n");
    expect(asked()).toBe(2);
    // The process is gone by the time herdr answers again with its pid: here too its locks cannot be
    // read, and the lookup ends there.
    answers(names([idle.pid]), async () => {
      idle.kill();
      await idle.exited;
      return names([idle.pid])();
    });
    expect(await agyFreshSession(pane, screen)).toBeNull();
    expect(asked()).toBe(2);
    expect(idle.killed).toBe(true);
    // And a process whose start identity cannot be read is not asked about again, as in resolveAgyStore.
    answers(names([idle.pid]));
    expect(await agyFreshSession(pane, screen)).toBeNull();
    expect(asked()).toBe(1);
  } finally {
    restore();
    idle.kill();
    await idle.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("reads a process's locks last, between two reads of its start identity that must agree, and after herdr's second answer", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-agy-order-")));
  const session = "00000000-0000-4000-8000-000000000004";
  const lock = join(root, "presence", `${session}.lock`);
  mkdirSync(join(root, "presence"));
  writeFileSync(lock, "");
  const pane = { pane_id: "agy-pane", agent: "agy" } as HerdrPane;
  // this test process stands in for the Agy: what a lookup reads of it, in the order it does. `reused`
  // has the identity read after the locks tell another start, as a pid another process took by then
  const order: string[] = [];
  const steps = ["ask", "identity", "ask", "locks", "identity"];
  let reused = false;
  const { readFileSync, opendirSync } = fs;
  const spies = [
    spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const read = readFileSync(...args);
      if (args[0] !== `/proc/${process.pid}/stat`) return read;
      order.push("identity");
      if (!reused || order.filter((step) => step === "identity").length < 2) return read;
      // the start time is field 22 of the line, the 20th after the command's closing bracket
      const stat = String(read);
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      fields[19] = String(BigInt(fields[19]!) + 1n);
      return `${stat.slice(0, stat.lastIndexOf(") ") + 2)}${fields.join(" ")}`;
    }) as typeof fs.readFileSync),
    spyOn(fs, "opendirSync").mockImplementation(((...args: Parameters<typeof fs.opendirSync>) => {
      if (args[0] === `/proc/${process.pid}/fd`) order.push("locks");
      return opendirSync(...args);
    }) as typeof fs.opendirSync),
  ];
  const { names, answers, restore } = processInfoAnswers();
  const ask = () => { order.push("ask"); return names([process.pid])(); };
  let held: number | null = null;
  try {
    // it holds no lock yet, as an Agy that has begun no conversation
    answers(ask, ask);
    expect(await agyFreshSession(pane, UNUSED_START_SCREEN)).toStartWith(`unwritten:agy:agy-pane:${process.pid}:`);
    expect(order).toEqual(steps);
    // The identity read after the locks decides. A pid another process took between herdr's second
    // answer and the lock read is told by nothing else: herdr named it and its locks were read, yet
    // with another start there the greeting is refused, every step having been taken.
    reused = true;
    order.length = 0;
    answers(ask, ask);
    expect(await agyFreshSession(pane, UNUSED_START_SCREEN)).toBeNull();
    expect(order).toEqual(steps);
    reused = false;
    held = fs.openSync(lock, "r");
    order.length = 0;
    answers(ask, ask);
    expect(await resolveAgyStore(pane)).toMatchObject({ root, session, pid: process.pid });
    expect(order).toEqual(steps);
    // and so is the store, though the lock that was read names one conversation
    reused = true;
    order.length = 0;
    answers(ask, ask);
    expect(await resolveAgyStore(pane)).toBeNull();
    expect(order).toEqual(steps);
  } finally {
    restore();
    for (const spy of spies) spy.mockRestore();
    if (held !== null) fs.closeSync(held);
    rmSync(root, { recursive: true, force: true });
  }
});
