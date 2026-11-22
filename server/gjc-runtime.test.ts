import { expect, it, spyOn } from "bun:test";
import * as darwinProcess from "./darwin-process.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { GJC_NATIVE_DIRECTORY, type GjcNativeBinding } from "../shared/gjc-native.ts";
import { forgetGjcPane, forgetGjcState, gjcPidUnderShell, gjcSessionFile, gjcTranscriptForPane, isGjcProcess, recentProcessTable, storeRelative, terminalBreadcrumb } from "./gjc-runtime.ts";

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

it("recognizes native and interpreter-launched gjc, not look-alikes", () => {
  expect(isGjcProcess(["/home/u/.local/bin/gjc", "--resume"])).toBe(true);
  expect(isGjcProcess(["gjc"])).toBe(true);
  expect(isGjcProcess(["/usr/bin/node", "/opt/gjc/dist/gjc.mjs"])).toBe(true);
  expect(isGjcProcess(["bun", "./gjc.js"])).toBe(true);
  expect(isGjcProcess(["/bin/zsh"])).toBe(false);
  expect(isGjcProcess(["gjc-helper"])).toBe(false);
  expect(isGjcProcess(["node", "/tmp/gjc/server.js"])).toBe(false);
  expect(isGjcProcess([])).toBe(false);
});

it("validates breadcrumbs against process age, canonical cwd and the native session store", () => {
  const home = tempDir("gjc-breadcrumb-");
  try {
    const store = join(home, ".gjc/agent/sessions/v2-project");
    const markers = join(home, ".gjc/agent/terminal-sessions");
    mkdirSync(store, { recursive: true }); mkdirSync(markers);
    const path = join(store, "session.jsonl"), marker = join(markers, "ttys003");
    writeFileSync(path, `${JSON.stringify({ type: "session", cwd: home })}\n`);
    writeFileSync(marker, `${home}\n${path}\n`);
    const agent = join(home, ".gjc/agent");
    expect(terminalBreadcrumb(agent, home, "ttys003", Date.now() - 1000)).toBe(path);
    expect(terminalBreadcrumb(agent, "/", "ttys003", 0)).toBeNull();
    expect(terminalBreadcrumb(agent, home, "../sessions/session.jsonl", 0)).toBeNull();
    utimesSync(marker, new Date(0), new Date(0));
    const startedAt = Date.now() - 60_000;
    utimesSync(path, new Date(), new Date());
    expect(terminalBreadcrumb(agent, home, "ttys003", startedAt)).toBeNull();
    const outside = join(home, "outside.jsonl"), escape = join(store, "escape.jsonl");
    writeFileSync(outside, `${JSON.stringify({ type: "session", cwd: home })}\n`); symlinkSync(outside, escape);
    writeFileSync(marker, `${home}\n${escape}\n`);
    expect(terminalBreadcrumb(agent, home, "ttys003", 0)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads a breadcrumb left on a subagent's file as the session that ran it", () => {
  const home = tempDir("gjc-subagent-");
  try {
    const root = join(home, ".gjc/agent/sessions"), store = join(root, "v2-project");
    const markers = join(home, ".gjc/agent/terminal-sessions");
    mkdirSync(join(store, "2026-09-29_session"), { recursive: true }); mkdirSync(markers, { recursive: true });
    const header = `${JSON.stringify({ type: "session", cwd: home })}\n`;
    const session = join(store, "2026-09-29_session.jsonl"), subagent = join(store, "2026-09-29_session", "2-Worker.jsonl");
    writeFileSync(session, header); writeFileSync(subagent, header);
    writeFileSync(join(markers, "pts-3"), `${home}\n${subagent}\n`);
    expect(terminalBreadcrumb(join(home, ".gjc/agent"), home, "pts-3", 0)).toBe(session);
    expect(gjcSessionFile(root, session)).toBe(session);
    expect(gjcSessionFile(root, subagent)).toBe(session);
    rmSync(session);
    expect(terminalBreadcrumb(join(home, ".gjc/agent"), home, "pts-3", 0)).toBeNull();
    expect(gjcSessionFile(root, subagent)).toBeNull();
    expect(gjcSessionFile(root, join(root, "top.jsonl"))).toBeNull();
    expect(gjcSessionFile(root, join(store, "a", "b", "c.jsonl"))).toBeNull();
    expect(gjcSessionFile(root, join(store, "notes.txt"))).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads a store on a Windows PC, where paths come with backslashes", () => {
  const root = "C:\\Users\\u\\.gjc\\agent\\sessions";
  const session = `${root}\\v2-project\\2026-10-01_session.jsonl`;
  expect(gjcSessionFile(root, session, win32)).toBe(session);
  expect(storeRelative(root, session, win32)).toEqual(["v2-project", "2026-10-01_session.jsonl"]);
  expect(gjcSessionFile(root, `c${session.slice(1)}`, win32)).toBe(`c${session.slice(1)}`);
  for (const outside of [
    `${root}-evil\\v2-project\\session.jsonl`,
    `${root}\\..\\sessions-evil\\v2-project\\session.jsonl`,
    "D:\\Users\\u\\.gjc\\agent\\sessions\\v2-project\\session.jsonl",
  ]) {
    expect(gjcSessionFile(root, outside, win32)).toBeNull();
    expect(storeRelative(root, outside, win32)).toBeNull();
  }
});

it("refuses a path that leaves the store on Linux and macOS too", () => {
  const root = "/home/u/.gjc/agent/sessions";
  expect(storeRelative(root, `${root}/v2-project/session.jsonl`)).toEqual(["v2-project", "session.jsonl"]);
  expect(storeRelative(root, `${root}-evil/v2-project/session.jsonl`)).toBeNull();
  expect(storeRelative(root, `${root}/../sessions-evil/v2-project/session.jsonl`)).toBeNull();
  expect(gjcSessionFile(root, `${root}/../sessions-evil/session.jsonl`)).toBeNull();
});

it("finds gjc under a Windows pane's shell, the only process herdr names there", async () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const gjc = "C:\\Users\\u\\AppData\\Local\\gjc\\gjc.exe";
  const rows = [
    { pid: 100, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 101, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 150, parent: 100, path: "C:\\Windows\\System32\\conhost.exe", commandLine: "conhost.exe" },
    { pid: 300, parent: 200, path: gjc, commandLine: `${gjc} sdk broker-internal` },
    { pid: 200, parent: 100, path: gjc, commandLine: `"${gjc}" --resume` },
  ];
  const table = async () => rows;
  expect(await gjcPidUnderShell(100, "win32", table)).toEqual({ pid: 200, started: null });
  expect(await gjcPidUnderShell(101, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(undefined, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(100, "win32", async () => rows.map((row) => row.pid === 200 ? { ...row, started: 7 } : row))).toEqual({ pid: 200, started: 7 });
  expect(await gjcPidUnderShell(100, "win32", async () => [])).toBeUndefined();
  let asked = false;
  expect(await gjcPidUnderShell(100, "linux", async () => { asked = true; return rows; })).toBeNull();
  expect(asked).toBe(false);
});

it("asks the Windows process table once for polls of a few seconds and forgets the snapshot", async () => {
  forgetGjcState();
  const rows = [{ pid: 100, parent: 4, path: null, commandLine: "powershell.exe" }];
  let asked = 0;
  const read = async () => { asked += 1; return rows; };
  expect(await recentProcessTable(read, 10_000)).toBe(rows);
  await Promise.all([recentProcessTable(read, 12_000), recentProcessTable(read, 14_000)]);
  expect(asked).toBe(1);
  await recentProcessTable(read, 16_000);
  expect(asked).toBe(2);
  forgetGjcState();
  await recentProcessTable(read, 16_001);
  expect(asked).toBe(3);
  let failed = 0;
  const unreadable = async () => { failed += 1; return []; };
  await recentProcessTable(unreadable, 21_001);
  await recentProcessTable(unreadable, 21_002);
  expect(failed).toBe(2);
  forgetGjcState();
});

function nativeFixture() {
  const home = tempDir("gjc-runtime-native-");
  const cwd = join(home, "work");
  const identityDir = join(home, ".gjc", "agent", GJC_NATIVE_DIRECTORY);
  const sessionsDir = join(home, ".gjc", "agent", "sessions", "v2-project");
  mkdirSync(cwd);
  mkdirSync(identityDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = (id: string, name = `${id}.jsonl`, sessionCwd = cwd) => {
    const path = join(sessionsDir, name);
    writeFileSync(path, `${JSON.stringify({ type: "session", id, cwd: sessionCwd })}\n{\"type\":\"message\"}\n`);
    return path;
  };
  const record = (pid: number, id: string, path: string, sequence = 1): GjcNativeBinding => ({
    version: 1,
    pid,
    processStartedAt: 1_000,
    instanceId: `extension-${pid}`,
    sequence,
    updatedAt: 10_000,
    session: { id, path, cwd },
  });
  const publish = (binding: GjcNativeBinding) => writeFileSync(join(identityDir, `${binding.pid}.json`), JSON.stringify(binding));
  const info = (...pids: number[]) => ({ process_info: { foreground_processes: pids.map((pid) => ({ pid, argv: ["/usr/bin/gjc"] })) } });
  const options = {
    platform: "linux",
    now: () => 10_000,
    processInfo: async () => info(200),
    processBirth: () => 1_000,
  };
  return { home, cwd, identityDir, sessionsDir, sessionFile, record, publish, info, options, done: () => rmSync(home, { recursive: true, force: true }) };
}

it("follows native session changes for new and resumed sessions on the same PID", async () => {
  const f = nativeFixture();
  try {
    const original = f.sessionFile("session-original");
    const fresh = f.sessionFile("session-new");
    f.publish(f.record(200, "session-original", original));
    expect(await gjcTranscriptForPane("pane", f.cwd, f.home, f.options)).toBe(realpathSync(original));

    f.publish(f.record(200, "session-new", fresh, 2));
    expect(await gjcTranscriptForPane("pane", f.cwd, f.home, f.options)).toBe(realpathSync(fresh));

    f.publish(f.record(200, "session-original", original, 3));
    expect(await gjcTranscriptForPane("pane", f.cwd, f.home, f.options)).toBe(realpathSync(original));
  } finally { f.done(); }
});

it("fails closed for multiple foreground GJC processes and reused PIDs", async () => {
  const f = nativeFixture();
  try {
    const path = f.sessionFile("session-a");
    f.publish(f.record(200, "session-a", path));
    f.publish(f.record(201, "session-b", f.sessionFile("session-b")));
    expect(await gjcTranscriptForPane("pane", f.cwd, f.home, {
      ...f.options,
      processInfo: async () => f.info(200, 201),
    })).toBeNull();
    expect(await gjcTranscriptForPane("pane", f.cwd, f.home, {
      ...f.options,
      processBirth: () => 2_000,
    })).toBeNull();
  } finally { f.done(); }
});

it("rechecks the native record after the asynchronous foreground-process read", async () => {
  const f = nativeFixture();
  try {
    const oldPath = f.sessionFile("session-old");
    const newPath = f.sessionFile("session-new");
    f.publish(f.record(200, "session-old", oldPath));

    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    let reads = 0;
    const processInfo = async () => {
      reads += 1;
      if (reads === 2) { reached(); await gate; }
      return f.info(200);
    };
    const lookup = gjcTranscriptForPane("pane", f.cwd, f.home, { ...f.options, processInfo });
    await waiting;
    f.publish(f.record(200, "session-new", newPath, 2));
    release();
    expect(await lookup).toBeNull();
    expect(await gjcTranscriptForPane("pane", f.cwd, f.home, f.options)).toBe(realpathSync(newPath));
  } finally { f.done(); }
});

it("accepts a heartbeat timestamp refresh without treating it as a new session identity", async () => {
  const f = nativeFixture();
  try {
    const path = f.sessionFile("session-a");
    const binding = f.record(200, "session-a", path);
    f.publish(binding);
    let clock = 10_000;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    let reads = 0;
    const processInfo = async () => {
      if (++reads === 2) { reached(); await gate; }
      return f.info(200);
    };
    const lookup = gjcTranscriptForPane("pane", f.cwd, f.home, { ...f.options, now: () => clock, processInfo });
    await waiting;
    clock += 1;
    f.publish({ ...binding, updatedAt: clock });
    release();
    expect(await lookup).toBe(realpathSync(path));
  } finally { f.done(); }
});

it("rechecks that the same GJC process remains foreground", async () => {
  const f = nativeFixture();
  try {
    const path = f.sessionFile("session-a");
    f.publish(f.record(200, "session-a", path));
    let reads = 0;
    expect(await gjcTranscriptForPane("pane", f.cwd, f.home, {
      ...f.options,
      processInfo: async () => f.info(++reads === 1 ? 200 : 201),
    })).toBeNull();
  } finally { f.done(); }
});

it("uses a fresh Windows process tree for the final birth-identity check", async () => {
  forgetGjcState();
  const f = nativeFixture();
  try {
    const path = f.sessionFile("session-a");
    f.publish(f.record(200, "session-a", path));
    const executable = "C:\\Users\\u\\AppData\\Local\\gjc\\gjc.exe";
    const rows = (started: number) => [{
      pid: 200, parent: 100, path: executable, commandLine: `"${executable}" --resume`, started,
    }];
    let tableReads = 0;
    const result = await gjcTranscriptForPane("pane", f.cwd, f.home, {
      platform: "win32",
      now: f.options.now,
      processInfo: async () => ({ process_info: { shell_pid: 100, foreground_processes: [] } }),
      readProcessTable: async () => ++tableReads === 1 ? rows(1_000) : rows(2_000),
    });
    expect(tableReads).toBe(2);
    expect(result).toBeNull();
  } finally { forgetGjcState(); f.done(); }
});

it("shares one fresh Windows process-table read between concurrent final checks", async () => {
  forgetGjcState();
  const f = nativeFixture();
  try {
    const path = f.sessionFile("session-a");
    f.publish(f.record(200, "session-a", path));
    const executable = "C:\\Users\\u\\AppData\\Local\\gjc\\gjc.exe";
    const rows = [{ pid: 200, parent: 100, path: executable, commandLine: `"${executable}" --resume`, started: 1_000 }];
    let tableReads = 0;
    let infoReads = 0;
    let release!: () => void;
    let bothFinal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrived = new Promise<void>((resolve) => { bothFinal = resolve; });
    const options = {
      platform: "win32",
      now: f.options.now,
      processInfo: async () => {
        if (++infoReads > 2) {
          if (infoReads === 4) bothFinal();
          await gate;
        }
        return { process_info: { shell_pid: 100, foreground_processes: [] } };
      },
      readProcessTable: async () => { tableReads += 1; return rows; },
    };
    const lookups = Promise.all([
      gjcTranscriptForPane("pane-a", f.cwd, f.home, options),
      gjcTranscriptForPane("pane-b", f.cwd, f.home, options),
    ]);
    await arrived;
    release();
    expect(await lookups).toEqual([realpathSync(path), realpathSync(path)]);
    expect(tableReads).toBe(2);
  } finally { forgetGjcState(); f.done(); }
});

it("starts another fresh Windows read when the pending read predates its initial check", async () => {
  forgetGjcState();
  const f = nativeFixture();
  const gate = Promise.withResolvers<void>();
  const firstFresh = Promise.withResolvers<void>();
  try {
    const path = f.sessionFile("session-a");
    f.publish(f.record(200, "session-a", path));
    const rows = [{ pid: 200, parent: 100, path: "gjc.exe", commandLine: "gjc.exe", started: 1_000 }];
    let tableReads = 0;
    const options = {
      platform: "win32",
      now: f.options.now,
      processInfo: async () => ({ process_info: { shell_pid: 100 } }),
      readProcessTable: async () => {
        const read = ++tableReads;
        if (read === 2) { firstFresh.resolve(); await gate.promise; }
        return read === 3 ? rows.map((row) => ({ ...row, started: 2_000 })) : rows;
      },
    };
    const first = gjcTranscriptForPane("pane-a", f.cwd, f.home, options);
    await firstFresh.promise;

    let infoReads = 0;
    const second = gjcTranscriptForPane("pane-b", f.cwd, f.home, {
      ...options,
      processInfo: async () => {
        const final = ++infoReads === 2;
        return { process_info: {
          get shell_pid() {
            if (final) gate.resolve();
            return 100;
          },
        } };
      },
    });

    expect(await second).toBeNull();
    expect(tableReads).toBe(3);
    expect(await first).toBe(realpathSync(path));
  } finally { gate.resolve(); forgetGjcState(); f.done(); }
});

it("cancels a running identity read when its pane ends", async () => {
  const f = nativeFixture();
  try {
    const path = f.sessionFile("session-a");
    f.publish(f.record(200, "session-a", path));
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    let reads = 0;
    const processInfo = async () => {
      if (++reads === 2) { reached(); await gate; }
      return f.info(200);
    };
    const lookup = gjcTranscriptForPane("pane", f.cwd, f.home, { ...f.options, processInfo });
    await waiting;
    forgetGjcPane("pane");
    release();
    expect(await lookup).toBeNull();
  } finally { forgetGjcState(); f.done(); }
});

async function onDarwinKernel<T>(startedMs: number, run: (spawned: { mock: { calls: unknown[] } }, blocking: { mock: { calls: unknown[] } }) => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const kernel = spyOn(darwinProcess, "darwinStartTime").mockReturnValue(BigInt(startedMs) * 1000n);
  const blocking = spyOn(Bun, "spawnSync");
  const spawned = spyOn(Bun, "spawn");
  try { return await run(spawned, blocking); } finally {
    spawned.mockRestore();
    blocking.mockRestore();
    kernel.mockRestore();
    Object.defineProperty(process, "platform", platform);
  }
}

it("reads the GJC process's birth from the kernel on macOS, with no ps child", async () => {
  const f = nativeFixture();
  const clock = spyOn(Date, "now").mockReturnValue(61_000);
  try {
    const path = f.sessionFile("session-darwin");
    f.publish(f.record(200, "session-darwin", path));
    const { processBirth: _sync, ...options } = f.options;
    await onDarwinKernel(1_000, async (spawned, blocking) => {
      expect(await gjcTranscriptForPane("pane", f.cwd, f.home, { ...options, platform: "darwin" })).toBe(realpathSync(path));
      expect(spawned.mock.calls).toHaveLength(0);
      expect(blocking.mock.calls).toHaveLength(0);
    });
  } finally { clock.mockRestore(); f.done(); }
});
