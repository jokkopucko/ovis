import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { AmbiguousClaudeStore, claudeAttachArgs, claudeAttachedJob, claudeAttachSession, claudeForegroundSession, claudeJobSession, claudeProcessSession, claudeSessionTempDir, claudeStoreKey, claudeStoreOf, claudeProjectDir, claudeTranscriptFile, claudeRecordOnlyIn, configDirInPsLine, darwinProcess, forgetClaudeSessions, herdrLaunchSource, isClaudeProcess, paneClaudeSource, processClaudeConfigDir, processClaudeSource, processLaunchSource, procArgsEnvironment } from "./claude-store.ts";
import { procStartTime } from "./darwin-process.ts";
import type { ProcessRow } from "./windows-processes.ts";

const NATIVE = process.platform === "linux" || process.platform === "darwin";
const SESSION = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";

describe("macOS kernel process start", () => {
  it("keeps microseconds from the leading 64-bit Darwin timeval, not its padding", () => {
    const answer = new Uint8Array(32).fill(0xff);
    const view = new DataView(answer.buffer, 8, 16);
    view.setBigInt64(0, 1792929600n, true);
    view.setInt32(8, 1, true);
    expect(procStartTime(answer.subarray(8, 24))).toBe(1792929600000001n);
    view.setInt32(8, 2, true);
    expect(procStartTime(answer.subarray(8, 24))).toBe(1792929600000002n);
    expect(procStartTime(answer.subarray(8, 23))).toBeNull();
    for (const micros of [-1, 1_000_000]) {
      view.setInt32(8, micros, true);
      expect(procStartTime(answer.subarray(8, 24))).toBeNull();
    }
    view.setInt32(8, 0, true);
    view.setBigInt64(0, 0n, true);
    expect(procStartTime(answer.subarray(8, 24))).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("reads a stable birth time for the live process from kern.proc.pid", () => {
    const started = darwinProcess.startTime(process.pid);
    expect(started).not.toBeNull();
    expect(started! > 0n && started! <= BigInt(Date.now()) * 1000n).toBe(true);
    expect(darwinProcess.startTime(process.pid)).toBe(started);
    expect(darwinProcess.startTime(0)).toBeNull();
  });
});

describe("isClaudeProcess", () => {
  it("knows the native build, whose process is titled Claude", () => {
    expect(isClaudeProcess({ name: "2.1.302", argv0: "Claude", argv: ["Claude"] })).toBe(true);
    expect(isClaudeProcess({ name: "Claude Helper", argv: ["/Applications/Claude.app/Contents/MacOS/Claude Helper"] })).toBe(false);
    // one field alone is not that shape
    expect(isClaudeProcess({ name: "2.1.302", argv0: "Claude", argv: ["Other"] })).toBe(false);
    expect(isClaudeProcess({ name: "2.1.302", argv0: "Other", argv: ["Claude"] })).toBe(false);
    // the native build as herdr reports it run from its lowercase `claude` launcher: the executable match
    expect(isClaudeProcess({ name: "2.1.306", argv0: "claude", argv: ["claude"] })).toBe(true);
  });

  it("knows the native build typed as Claude on a case-insensitive Mac disk", () => {
    // recorded on macOS 27 (case-insensitive APFS): `Claude` finds the ~/.local/bin/claude link, so
    // herdr's name is the versioned binary behind it and argv0/argv[0] keep the typed `Claude`
    expect(isClaudeProcess({ name: "2.1.999", argv0: "Claude", argv: ["Claude", "42"] })).toBe(true);
  });
});

describe("claudeProcessSession", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function nativeRecord(patch: Record<string, unknown> = {}): string {
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-pid-"));
    roots.push(home);
    const dir = join(home, ".claude", "sessions");
    mkdirSync(dir, { recursive: true });
    // as Claude Code records it: month before day, whatever the user's locale
    const procStart = process.platform === "linux"
      ? readFileSync("/proc/self/stat", "utf8").split(") ").pop()?.split(" ")[19]
      : Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.toString().trim();
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: SESSION, procStart, kind: "interactive", ...patch,
    }));
    return home;
  }

  it.skipIf(!NATIVE)("reads an exact live PID's session without a cwd guess", async () => {
    const home = nativeRecord();
    expect(await claudeProcessSession(home, process.pid)).toBe(SESSION);
  });

  // the test process stands in for the pane's Claude; its own CLAUDE_CONFIG_DIR would name another store
  it.skipIf(!NATIVE || Boolean(process.env["CLAUDE_CONFIG_DIR"]))("reads the session a pane's one Claude process records, which /clear rewrites (#540)", async () => {
    const home = nativeRecord();
    const claude = { pid: process.pid, name: "claude", argv0: null, argv: null };
    expect(await claudeForegroundSession([claude], home)).toBe(SESSION);
    const cleared = "1c9e7f0e-8d3f-4c1a-9a53-6c2b7a1d9e43";
    const path = join(home, ".claude", "sessions", `${process.pid}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), sessionId: cleared }));
    expect(await claudeForegroundSession([claude], home)).toBe(cleared);
    // control: no single Claude process, no session
    expect(await claudeForegroundSession([], home)).toBeNull();
    expect(await claudeForegroundSession([claude, { ...claude, pid: process.pid + 1 }], home)).toBeNull();
    expect(await claudeForegroundSession([{ ...claude, name: "bash" }], home)).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("reads it on a Mac whose locale puts the day first", async () => {
    const home = nativeRecord();
    const saved = process.env["LC_ALL"];
    // en_GB's ps prints "Fri  9 Oct …" for the "Fri Oct  9 …" Claude recorded
    process.env["LC_ALL"] = "en_GB.UTF-8";
    try {
      expect(await claudeProcessSession(home, process.pid)).toBe(SESSION);
    } finally {
      if (saved === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = saved;
    }
  });

  for (const [name, patch] of [
    ["another PID", { pid: process.pid + 1 }],
    ["a reused PID", { procStart: "1" }],
    ["an older record without start ticks", { procStart: null }],
    ["a noninteractive SDK session", { kind: "sdk" }],
    ["a path in place of a UUID", { sessionId: "../../other" }],
    ["a missing session ID", { sessionId: null }],
  ] satisfies [string, Record<string, unknown>][]) {
    it.skipIf(!NATIVE)(`rejects ${name}`, async () => {
      const home = nativeRecord(patch);
      expect(await claudeProcessSession(home, process.pid)).toBeNull();
    });
  }

  it.skipIf(!NATIVE)("returns no identity for absent, torn or oversized records", async () => {
    const home = nativeRecord();
    const path = join(home, ".claude", "sessions", `${process.pid}.json`);
    rmSync(path);
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    writeFileSync(path, "{");
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    writeFileSync(path, JSON.stringify({ padding: "x".repeat(16 * 1024) }));
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    expect(await claudeProcessSession(home, -1)).toBeNull();
  });

  it.skipIf(!NATIVE)("does not wait on a FIFO or follow a link in the record's place", async () => {
    const home = nativeRecord();
    const path = join(home, ".claude", "sessions", `${process.pid}.json`);
    const target = join(home, "elsewhere.json");
    renameSync(path, target);
    symlinkSync(target, path);
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    rmSync(path);
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const started = Date.now();
    expect(await claudeProcessSession(home, process.pid)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("a claude attach pane's job (#1645)", () => {
  const JOB = "dc5643bd";
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    forgetClaudeSessions();
  });
  function store(): string {
    const root = mkdtempSync(join(tmpdir(), "ovis-claude-job-"));
    roots.push(root);
    mkdirSync(join(root, "jobs", JOB), { recursive: true });
    return root;
  }
  const statePath = (dir: string): string => join(dir, "jobs", JOB, "state.json");

  it("reads `attach` as Claude does: its first operand, and behind root options only with a whole id", () => {
    const first = (ref: string, byName = true) => ({ ref, behindOptions: false, byName });
    const behind = { ref: JOB, behindOptions: true, byName: false };
    expect(claudeAttachArgs(["claude", "attach", JOB])).toEqual(first(JOB));
    expect(claudeAttachArgs(["/home/me/.local/bin/claude", "attach", JOB])).toEqual(first(JOB));
    expect(claudeAttachArgs(["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "attach", JOB])).toEqual(first(JOB));
    expect(claudeAttachArgs(["C:\\Program Files\\nodejs\\node.exe", "C:\\npm\\cli.js", "attach", JOB])).toEqual(first(JOB));
    // part of an id, or of a name only when nothing follows it
    expect(claudeAttachArgs(["claude", "attach", "dc56"])).toEqual(first("dc56"));
    expect(claudeAttachArgs(["claude", "attach", "release notes"])).toEqual(first("release notes"));
    expect(claudeAttachArgs(["claude", "attach", "release", "notes"])).toEqual(first("release", false));
    // debug options and --setting-sources after a name: Claude still reads it as a name (#1876)
    for (const after of [["--debug"], ["-d"], ["--debug=api"], ["-d2e"], ["--debug-to-stderr", "--setting-sources", "user,project"], ["--setting-sources=user"]]) {
      expect(claudeAttachArgs(["claude", "attach", "release", ...after])).toEqual(first("release"));
    }
    // anything else after it keeps the terminal, a debug value apart from its option too: Claude (2.1.311) takes it
    // for an extra argument and looks no name up (#2125)
    for (const after of [["--verbose"], ["--setting-sources"], ["-d", "api,hooks"], ["--debug", "api"], ["--debug", "api", "notes"], ["-d", "--verbose"], ["--model", "opus"]]) {
      expect(claudeAttachArgs(["claude", "attach", "release", ...after])).toEqual(first("release", false));
    }
    // root options before it, each with the values it takes
    expect(claudeAttachArgs(["claude", "--model", "opus", "attach", JOB])).toEqual(behind);
    expect(claudeAttachArgs(["claude", "--model=opus", "--dangerously-skip-permissions", "attach", JOB])).toEqual(behind);
    expect(claudeAttachArgs(["claude", "--add-dir", "a", "b", "--verbose", "attach", JOB])).toEqual(behind);
    expect(claudeAttachArgs(["claude", "--debug", "--verbose", "attach", JOB])).toEqual(behind);
    expect(claudeAttachArgs(["claude", "-r", "./resumed.js", "attach", JOB])).toEqual(behind);
    // an option's value that reads `attach` is no attach
    expect(claudeAttachArgs(["claude", "--add-dir", "a", "attach", JOB])).toBeNull();
    expect(claudeAttachArgs(["claude", "--debug", "attach", JOB])).toBeNull();
    expect(claudeAttachArgs(["claude", "-r", "attach", JOB])).toBeNull();
    expect(claudeAttachArgs(["claude", "--append-system-prompt", "attach", "deadbeef"])).toBeNull();
    // behind options, only a whole id, and only after options Claude reads a subcommand behind
    expect(claudeAttachArgs(["claude", "--model", "opus", "attach", "dc56"])).toBeNull();
    for (const option of ["-p", "--bg", "--routine=nightly", "-cp", "--version", "--unknown-option"]) {
      expect(claudeAttachArgs(["claude", option, "attach", JOB])).toBeNull();
    }
    expect(claudeAttachArgs(["claude", "--exec", "x", "attach", JOB])).toBeNull();
    expect(claudeAttachArgs(["claude", "--", "attach", JOB])).toBeNull();
    // a prompt, help, or no argument
    expect(claudeAttachArgs(["claude", "prompt", "attach", JOB])).toBeNull();
    expect(claudeAttachArgs(["claude", "attach", "--help"])).toBeNull();
    expect(claudeAttachArgs(["claude", "attach", ""])).toBeNull();
    expect(claudeAttachArgs(["claude", "attach"])).toBeNull();
    expect(claudeAttachArgs(["claude", "--resume", SESSION])).toBeNull();
    expect(claudeAttachArgs([])).toBeNull();
    expect(claudeAttachArgs(null)).toBeNull();
  });

  const CREATED = "2020-01-01T00:00:00.000Z";
  /** A job's state with the fields Claude requires of it, as Claude writes them. */
  const job = (dir: string, id: string, state: Record<string, unknown> | string): void => {
    mkdirSync(join(dir, "jobs", id), { recursive: true });
    writeFileSync(join(dir, "jobs", id, "state.json"), typeof state === "string" ? state : JSON.stringify({
      state: "working", detail: "", template: "bg", intent: `task of ${id}`, sessionId: `${id}-6228-4376-a66c-ad9820b26f37`, cwd: "/work",
      createdAt: CREATED, updatedAt: CREATED, ...state,
    }));
  };
  /** When the clients below started, after every job made at CREATED. */
  const STARTED = Date.parse("2020-01-10T00:00:00.000Z");
  // each client below runs only while it is looked up; afterwards its pid is another, later process's
  let pid = 5_000_000;
  const live = new Set<number>();
  const opened = async (dir: string, ref: string, byName = true, started: number | null = STARTED) => {
    const client = ++pid;
    live.add(client);
    try {
      return await claudeAttachedJob(dir, client, { ref, behindOptions: false, byName },
        async (of) => live.has(of) || of === process.pid ? started : STARTED + 60_000);
    } finally { live.delete(client); }
  };

  it("opens the one job whose id starts with the argument", async () => {
    const dir = store();
    job(dir, JOB, {});
    job(dir, "dc5fffff", {});
    expect(await opened(dir, "dc56")).toBe(JOB);
    expect(await opened(dir, "dc5")).toBeNull();
    expect(await opened(dir, "0bad")).toBeNull();
    // a whole id is the job, read off its own state
    expect(await opened(dir, "0badc0de")).toBe("0badc0de");
    expect(await opened(join(dir, "missing"), "dc56")).toBeNull();
  });

  it("opens the one job a name names, where another's task text counts against it unless that job is over", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes draft" });
    job(dir, "aaaa2222", { name: "Fix login page", intent: "fix the page" });
    // a job folder Claude has not written a state into yet
    mkdirSync(join(dir, "jobs", "bbbb3333"));
    expect(await opened(dir, "release")).toBe(JOB);
    expect(await opened(dir, "  Release Notes Draft ")).toBe(JOB);
    expect(await opened(dir, "login page")).toBe("aaaa2222");
    // task text alone names no job, and neither does a name with something after it
    expect(await opened(dir, "the page")).toBeNull();
    expect(await opened(dir, "release", false)).toBeNull();
    // text that can start an id is never part of a name
    job(dir, "cccc4444", { name: "cafe" });
    expect(await opened(dir, "cafe")).toBeNull();
    // two names, or a name and the task text of a job still going
    job(dir, "dddd5555", { name: "Release v2" });
    expect(await opened(dir, "release")).toBeNull();
    rmSync(join(dir, "jobs", "dddd5555"), { recursive: true });
    for (const [state, opens] of [
      [{ state: "working" }, null],
      [{ state: "done", tempo: "idle" }, JOB],
      [{ state: "failed", tempo: "idle" }, JOB],
      [{ state: "stopped", tempo: "active" }, null],
      // a job that is done but wakes again is not over
      [{ state: "done", tempo: "idle", routine: "nightly" }, null],
      [{ state: "done", tempo: "idle", selfWake: true }, null],
      [{ state: "done", tempo: "idle", inFlight: { tasks: 0, queued: 0, kinds: ["session_cron"] } }, null],
      [{ state: "done", tempo: "idle", initialPrompt: " /loop check the release" }, null],
    ] as const) {
      job(dir, "eeee6666", { name: "Blog", intent: "write the release blog", ...state });
      expect(await opened(dir, "release")).toBe(opens);
    }
  });

  it("leaves out a job whose state Claude would not load, as Claude does", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes", intent: 23 });
    expect(await opened(dir, "release")).toBeNull();
    job(dir, "aaaa2222", { name: "Release v2" });
    expect(await opened(dir, "release")).toBe("aaaa2222");
    for (const broken of [{ sessionId: undefined }, { template: undefined }, { createdAt: 1 }, { name: ["release"] }, { detail: null }, { displayIntent: 5 }, { routine: 5 }, { inFlight: { tasks: 0, queued: 0 } }, { inFlight: { tasks: "0", queued: 0, kinds: [] } }]) {
      job(dir, JOB, { name: "Release notes", ...broken });
      expect(await opened(dir, "release")).toBe("aaaa2222");
    }
  });

  it("leaves out jobs made after the client started, and opens none by part of an id or name when its start is unknown", async () => {
    const dir = store();
    const later = "2020-01-20T00:00:00.000Z";
    job(dir, JOB, { name: "Release notes" });
    // the client cannot have opened a job made after it started: Claude found its job then
    job(dir, "aaaa2222", { name: "Release v2", createdAt: later });
    expect(await opened(dir, "release")).toBe(JOB);
    job(dir, "dc56ffff", { createdAt: later });
    expect(await opened(dir, "dc56")).toBe(JOB);
    // the job it opened was renamed or removed since: the later one is still not it
    rmSync(join(dir, "jobs", JOB), { recursive: true });
    expect(await opened(dir, "release")).toBeNull();
    expect(await opened(dir, "dc56")).toBeNull();
    job(dir, JOB, { name: "Release notes" });
    expect(await opened(dir, "release")).toBe(JOB);
    // a client whose start cannot be told might have opened a job since renamed
    expect(await opened(dir, "release", true, null)).toBeNull();
    expect(await opened(dir, "dc5643", true, null)).toBeNull();
    // a whole id needs no finding
    expect(await opened(dir, JOB, true, null)).toBe(JOB);
    // a later job whose state cannot be read might be older: it counts
    job(dir, "dc56ffff", "{");
    expect(await opened(dir, "dc56")).toBeNull();
  });

  it("opens no job by name while a job's state cannot be read", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes draft" });
    expect(await opened(dir, "release")).toBe(JOB);
    // that job might be named by it too: Claude may read what this cannot
    job(dir, "aaaa2222", "{");
    expect(await opened(dir, "release")).toBeNull();
    job(dir, "aaaa2222", JSON.stringify({ name: "Other", output: "x".repeat(256 * 1024) }));
    expect(await opened(dir, "release")).toBeNull();
    // an id still opens it
    expect(await opened(dir, "dc56")).toBe(JOB);
  });

  it.skipIf(!NATIVE)("opens no job by name while another job's state is a link, a folder or a FIFO", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes draft" });
    job(dir, "aaaa2222", { name: "Other" });
    const other = join(dir, "jobs", "aaaa2222", "state.json");
    renameSync(other, join(dir, "elsewhere.json"));
    symlinkSync(join(dir, "elsewhere.json"), other);
    expect(await opened(dir, "release")).toBeNull();
    rmSync(other);
    mkdirSync(other);
    expect(await opened(dir, "release")).toBeNull();
    rmSync(other, { recursive: true });
    expect(Bun.spawnSync(["mkfifo", other]).exitCode).toBe(0);
    expect(await opened(dir, "release")).toBeNull();
  });

  it("keeps the job a client opened when jobs are renamed or added later", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes draft" });
    const client = { ref: "release", behindOptions: false, byName: true };
    const at = (started: number) => async () => started;
    expect(await claudeAttachedJob(dir, 4_242_424, client, at(STARTED))).toBe(JOB);
    // Claude found its job once, as it started
    job(dir, JOB, { name: "Changelog" });
    job(dir, "aaaa2222", { name: "Release v2" });
    expect(await claudeAttachedJob(dir, 4_242_424, client, at(STARTED))).toBe(JOB);
    // another client with the same argument, or another process with the same pid, finds what Claude would find now
    expect(await claudeAttachedJob(dir, 4_242_425, client, at(STARTED))).toBe("aaaa2222");
    expect(await claudeAttachedJob(dir, 4_242_424, client, at(STARTED + 60_000))).toBe("aaaa2222");
    forgetClaudeSessions();
    expect(await claudeAttachedJob(dir, 4_242_424, client, at(STARTED))).toBe("aaaa2222");
  });

  // the clients that came and went left their pids to later processes: only a start that moved tells them gone
  it("keeps a live client's job however many other clients come and go", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes draft" });
    const client = { ref: "release", behindOptions: false, byName: true };
    const started = async () => STARTED;
    expect(await claudeAttachedJob(dir, process.pid, client, started)).toBe(JOB);
    for (let other = 0; other < 300; other++) expect(await opened(dir, "dc56")).toBe(JOB);
    job(dir, JOB, { name: "Changelog" });
    job(dir, "aaaa2222", { name: "Release v2" });
    expect(await claudeAttachedJob(dir, process.pid, client, started)).toBe(JOB);
  });

  it("tells a gone client by its pid's start, never by a signal, and keeps one whose start cannot be read now", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes draft" });
    const client = { ref: "release", behindOptions: false, byName: true };
    // every pid below still takes a signal; only its start tells whether it is the same process
    const starts = new Map<number, number | null>();
    const startOf = async (of: number) => starts.has(of) ? starts.get(of)! : STARTED;
    for (let other = 1; other <= 256; other++) {
      starts.set(other, STARTED);
      expect(await claudeAttachedJob(dir, other, client, startOf, () => true)).toBe(JOB);
    }
    // all 256 still run: a new client is not remembered, and keeps its terminal
    expect(await claudeAttachedJob(dir, 1000, client, startOf, () => true)).toBeNull();
    // starts that cannot be read now tell nothing
    for (let other = 1; other <= 256; other++) starts.set(other, null);
    expect(await claudeAttachedJob(dir, 1001, client, startOf, () => true)).toBeNull();
    // pid 7 now runs another process: that client is gone
    starts.set(7, STARTED + 60_000);
    expect(await claudeAttachedJob(dir, 1002, client, startOf, () => true)).toBe(JOB);
  });

  it("keeps the entry another lookup put in place while the remembered jobs were pruned", async () => {
    const dir = store();
    job(dir, JOB, { name: "Release notes draft" });
    const client = { ref: "release", behindOptions: false, byName: true };
    for (let other = 1; other <= 256; other++) expect(await claudeAttachedJob(dir, other, client, async () => STARTED, () => true)).toBe(JOB);
    // a new client prunes; its read of pid 1's start answers only when the test says
    const later = STARTED + 60_000;
    let asked: () => void = () => {};
    const askedForPid1 = new Promise<void>((resolve) => { asked = resolve; });
    let answer: (start: number) => void = () => {};
    const pid1Start = new Promise<number>((resolve) => { answer = resolve; });
    const pruning = claudeAttachedJob(dir, 9999, client, async (of) => { if (of !== 1) return STARTED; asked(); return await pid1Start; }, () => true);
    await askedForPid1;
    // meanwhile pid 1 runs a later client, which opens the job named so now
    job(dir, JOB, { name: "Changelog" });
    job(dir, "aaaa2222", { name: "Release v2" });
    expect(await claudeAttachedJob(dir, 1, client, async () => later, () => true)).toBe("aaaa2222");
    job(dir, "aaaa2222", { name: "Blog" });
    answer(later);
    expect(await pruning).toBeNull();
    // that later client's job is still the one it opened
    expect(await claudeAttachedJob(dir, 1, client, async () => later, () => true)).toBe("aaaa2222");
  });

  it("shows the session of the job an attach client opened, and none for any other process", async () => {
    const dir = store();
    const started = `${JOB}-6228-4376-a66c-ad9820b26f37`;
    // this test process stands in for the client: its jobs were made before it started
    job(dir, JOB, { name: "Release notes draft", sessionId: started, resumeSessionId: SESSION });
    job(dir, "aaaa2222", { name: "Shell", command: "sleep 100", sessionId: undefined });
    expect(await claudeAttachSession(dir, process.pid, ["claude", "attach", "release"])).toEqual({ session: SESSION });
    expect(await claudeAttachSession(dir, process.pid, ["claude", "attach", JOB])).toEqual({ session: SESSION });
    // a shell-command job, or no job found: an attach client showing no session
    expect(await claudeAttachSession(dir, process.pid, ["claude", "attach", "aaaa"])).toEqual({ session: null });
    expect(await claudeAttachSession(dir, process.pid, ["claude", "attach", "nothing"])).toEqual({ session: null });
    expect(await claudeAttachSession(dir, process.pid, ["claude", "--resume", SESSION])).toBeNull();
  });

  // the test process stands in for the client; its own CLAUDE_CONFIG_DIR would name another store
  it.skipIf(Boolean(process.env["CLAUDE_CONFIG_DIR"]))("pins queued input to the session of the job an attach client opened (#1876)", async () => {
    const home = mkdtempSync(join(tmpdir(), "ovis-claude-attach-home-"));
    roots.push(home);
    const dir = join(home, ".claude");
    job(dir, JOB, { sessionId: `${JOB}-6228-4376-a66c-ad9820b26f37`, resumeSessionId: SESSION });
    const client = { pid: process.pid, name: "claude", argv0: "claude", argv: ["claude", "attach", JOB] };
    expect(await claudeForegroundSession([client], home)).toBe(SESSION);
    // a job with no session (a shell command) pins none, as does a client not alone in the pane
    job(dir, JOB, { command: "sleep 100", sessionId: undefined });
    expect(await claudeForegroundSession([client], home)).toBeNull();
    expect(await claudeForegroundSession([client, { ...client, pid: process.pid + 1 }], home)).toBeNull();
  });

  // CLAUDE_CODE_SESSION_KIND=bg makes Claude read no subcommand behind options: it runs an interactive Claude
  it.skipIf(!NATIVE)("reads `attach` behind options only from a client whose environment is no background session's", async () => {
    const dir = store();
    job(dir, JOB, { sessionId: SESSION });
    const behind = ["claude", "--model", "opus", "attach", JOB];
    // a started user process stands for the client: macOS 27 hides a system binary's (/bin/sh's) environment.
    // It prints once it runs with the environment it was given, then waits on its input
    const client = async (env: Record<string, string>) => {
      const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); console.log('ready')"], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdin: "pipe", stdout: "pipe" });
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      return child;
    };
    const background = await client({ CLAUDE_CODE_SESSION_KIND: "bg" });
    const plain = await client({ CLAUDE_CODE_SESSION_KIND: "interactive" });
    try {
      expect(await claudeAttachSession(dir, background.pid, behind)).toBeNull();
      expect(await claudeAttachSession(dir, plain.pid, behind)).toEqual({ session: SESSION });
      // `attach` first is an attach in any environment
      expect(await claudeAttachSession(dir, background.pid, ["claude", "attach", JOB])).toEqual({ session: SESSION });
      // an environment that cannot be read tells nothing: maybe an attach client, so no session at all
      expect(await claudeAttachSession(dir, 5_999_999, behind)).toEqual({ session: null });
    } finally {
      background.kill();
      plain.kill();
      await Promise.all([background.exited, plain.exited]);
    }
  });

  it("reads the session the job shows now, else the one it started with", async () => {
    const dir = store();
    const started = `${JOB}-6228-4376-a66c-ad9820b26f37`;
    writeFileSync(statePath(dir), JSON.stringify({ sessionId: started, resumeSessionId: SESSION, state: "running" }));
    expect(await claudeJobSession(dir, JOB)).toBe(SESSION);
    writeFileSync(statePath(dir), JSON.stringify({ sessionId: started }));
    expect(await claudeJobSession(dir, JOB)).toBe(started);
  });

  it("names no session for a shell-command job, an unusable state or none", async () => {
    const dir = store();
    for (const state of [{ state: "running" }, { sessionId: "not-a-session" }, { resumeSessionId: "x", sessionId: SESSION }, null, []]) {
      writeFileSync(statePath(dir), JSON.stringify(state));
      expect(await claudeJobSession(dir, JOB)).toBeNull();
    }
    writeFileSync(statePath(dir), "{");
    expect(await claudeJobSession(dir, JOB)).toBeNull();
    // too large to be a job's state, even when its session comes first
    writeFileSync(statePath(dir), JSON.stringify({ sessionId: SESSION, output: "x".repeat(256 * 1024) }));
    expect(await claudeJobSession(dir, JOB)).toBeNull();
    expect(await claudeJobSession(dir, "0badc0de")).toBeNull();
  });

  it("names no session when the state cannot be read off the disk", async () => {
    const dir = store();
    writeFileSync(statePath(dir), JSON.stringify({ sessionId: SESSION }));
    const opened = spyOn(fsPromises, "open").mockImplementation(async () => { throw Object.assign(new Error("EIO: i/o error, open"), { code: "EIO" }); });
    try {
      // the pane keeps its terminal rather than the conversation route answering an error
      expect(await claudeJobSession(dir, JOB)).toBeNull();
      expect(opened).toHaveBeenCalled();
    } finally { opened.mockRestore(); }
  });

  it.skipIf(!NATIVE)("reads no link, directory or FIFO in the state's place, without blocking", async () => {
    const dir = store();
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ sessionId: SESSION }));
    symlinkSync(target, statePath(dir));
    expect(await claudeJobSession(dir, JOB)).toBeNull();
    rmSync(statePath(dir));
    mkdirSync(statePath(dir));
    expect(await claudeJobSession(dir, JOB)).toBeNull();
    rmSync(statePath(dir), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", statePath(dir)]).exitCode).toBe(0);
    expect(await claudeJobSession(dir, JOB)).toBeNull();
  });
});

describe("claudeProjectDir", () => {
  it("encodes a cwd the way Claude Code names its project", () => {
    expect(claudeProjectDir("/home/u/project")).toBe("-home-u-project");
    expect(claudeProjectDir("/home/u/Development/test.com")).toBe("-home-u-Development-test-com");
    expect(claudeProjectDir("/home/u/my_project")).toBe("-home-u-my-project");
    expect(claudeProjectDir("/home/u/.dotfiles")).toBe("-home-u--dotfiles");
    expect(claudeProjectDir("/home/u/문서/app")).toBe("-home-u----app");
    expect(claudeProjectDir("/home/u/My Project")).toBe("-home-u-My-Project");
  });

  it("cuts a name past 200 characters and adds the hash of the whole path", () => {
    const cwd = `/home/u/${"deep/".repeat(45)}project`;
    expect(claudeProjectDir(cwd)).toBe(`${"-home-u-" + "deep-".repeat(38)}de-5cuwtt`);
    expect(claudeProjectDir(cwd).length).toBe(207);
  });
});

describe("claudeTranscriptFile", () => {
  const roots: string[] = [];
  afterEach(() => { forgetClaudeSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function home(): { home: string; projects: string } {
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-store-"));
    roots.push(home);
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    return { home, projects };
  }
  function transcript(projects: string, project: string): string {
    mkdirSync(join(projects, project), { recursive: true });
    const path = join(projects, project, `${SESSION}.jsonl`);
    writeFileSync(path, "{}\n");
    return path;
  }

  it("finds a session under a cwd with a dot, an underscore, a space or Korean", async () => {
    for (const cwd of ["/w/example.com", "/w/my_project", "/w/My Project", "/w/문서/app", "/w/.dotfiles"]) {
      const { home: dir, projects } = home();
      const path = transcript(projects, claudeProjectDir(cwd));
      expect(await claudeTranscriptFile(dir, SESSION, [cwd])).toBe(path);
    }
  });

  it("tries each cwd in turn, then finds the session in whichever project holds it", async () => {
    const { home: dir, projects } = home();
    const started = transcript(projects, claudeProjectDir("/w/started-here"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on", null, "/w/started-here"])).toBe(started);
    // neither cwd names the project (Claude started elsewhere, or named it another way)
    renameSync(join(projects, claudeProjectDir("/w/started-here")), join(projects, "-some-other-name"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBe(join(projects, "-some-other-name", `${SESSION}.jsonl`));
    // a remembered file that has gone is looked up again, not answered
    rmSync(join(projects, "-some-other-name"), { recursive: true });
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBeNull();
  });

  it("keeps a session found by a scan to the store it was found in", async () => {
    const first = home(), second = home();
    transcript(first.projects, "-elsewhere");
    expect(await claudeTranscriptFile(first.home, SESSION, ["/w/project"])).toBe(join(first.projects, "-elsewhere", `${SESSION}.jsonl`));
    expect(await claudeTranscriptFile(second.home, SESSION, ["/w/project"])).toBeNull();
  });

  it("reports a store it cannot read instead of calling the transcript missing", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const { home: dir, projects } = home();
    chmodSync(projects, 0o000);
    try { await expect(claudeTranscriptFile(dir, SESSION, [])).rejects.toThrow(); }
    finally { chmodSync(projects, 0o700); }
    // an unreadable project beside the one holding the session: the session is still found
    const hit = transcript(projects, "-readable");
    mkdirSync(join(projects, "-locked"));
    chmodSync(join(projects, "-locked"), 0o000);
    try { expect(await claudeTranscriptFile(dir, SESSION, [])).toBe(hit); }
    finally { chmodSync(join(projects, "-locked"), 0o700); }
    // and without a hit, the unreadable project is reported, not called missing
    forgetClaudeSessions();
    rmSync(hit);
    chmodSync(join(projects, "-locked"), 0o000);
    try { await expect(claudeTranscriptFile(dir, SESSION, [])).rejects.toThrow(); }
    finally { chmodSync(join(projects, "-locked"), 0o700); }
  });

  it("answers null without a projects store or a file for the session", async () => {
    const { home: dir } = home();
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBeNull();
    expect(await claudeTranscriptFile(join(dir, "missing"), SESSION, ["/w/project"])).toBeNull();
  });

  it("follows Claude's continued-in chain to the active transcript", async () => {
    const { home: dir, projects } = home();
    const project = claudeProjectDir("/w/project");
    const folder = join(projects, project);
    const continued = "11111111-1111-4111-8111-111111111111";
    const activeId = "22222222-2222-4222-8222-222222222222";
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${SESSION}.jsonl`), [
      { type: "last-prompt", sessionId: SESSION },
      { type: "continued-in", sessionId: SESSION, continuedInSessionId: continued },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    writeFileSync(join(folder, `${continued}.jsonl`), JSON.stringify({ type: "continued-in", sessionId: continued, continuedInSessionId: activeId }));
    const active = join(folder, `${activeId}.jsonl`);
    writeFileSync(active, [
      { type: "user", message: { content: "Prompt after continue" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Answer after continue" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(active);
  });

  it("keeps a transcript whose continued-in record is followed by newer turns, or names no file", async () => {
    const { home: dir, projects } = home();
    const folder = join(projects, claudeProjectDir("/w/project"));
    const other = "33333333-3333-4333-8333-333333333333";
    const missing = "44444444-4444-4444-8444-444444444444";
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${other}.jsonl`), JSON.stringify({ type: "user", message: { content: "old" } }));
    const original = join(folder, `${SESSION}.jsonl`);
    writeFileSync(original, [
      { type: "continued-in", sessionId: SESSION, continuedInSessionId: other },
      { type: "user", message: { content: "Newer prompt" } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    // a newer turn whose keys are escaped is a newer turn all the same (#2130)
    writeFileSync(original, [
      JSON.stringify({ type: "continued-in", sessionId: SESSION, continuedInSessionId: other }),
      JSON.stringify({ type: "user", message: { content: "Newer prompt" } }).replace('"type"', '"\\u0074ype"'),
    ].join("\n"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    writeFileSync(original, JSON.stringify({ type: "continued-in", sessionId: SESSION, continuedInSessionId: missing }));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
  });

  describe("a /resume of a background session", () => {
    const PARKED = "e4159264-2222-4222-8222-222222222222";
    const BG = "8b80137e-f8fe-4aaa-8bbb-cccccccccccc";
    const resumed = (folder: string, jobId = "8b80137e") => {
      const original = join(folder, `${SESSION}.jsonl`);
      writeFileSync(original, [
        { type: "user", message: { content: "/resume" } },
        { type: "user", message: { content: `<local-command-stdout>Opening \"title\", running in the background (${jobId})</local-command-stdout>` } },
        { type: "continued-in", sessionId: SESSION, continuedInSessionId: PARKED },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      return original;
    };

    it("follows the output's job id to that job's transcript (regression: fails on main)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      resumed(folder);
      const job = join(folder, `${BG}.jsonl`);
      writeFileSync(job, JSON.stringify({ type: "user", message: { content: "real conversation prompt" } }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(job);
      // the same records written with a space after each colon (#2130)
      const original = join(folder, `${SESSION}.jsonl`);
      writeFileSync(original, readFileSync(original, "utf8").replaceAll('":', '": '));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(job);
    });

    it("keeps the named transcript when no file, or more than one, matches the job id (control)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = resumed(folder);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
      writeFileSync(join(folder, `${BG}.jsonl`), "{}");
      writeFileSync(join(folder, "8b80137e-0000-4000-8000-000000000000.jsonl"), "{}");
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    });

    it("ignores an earlier /resume's job id when the active continuation has no job output (regression)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = join(folder, `${SESSION}.jsonl`);
      writeFileSync(original, [
        { type: "user", message: { content: "<local-command-stdout>Opening, running in the background (8b80137e)</local-command-stdout>" } },
        { type: "continued-in", sessionId: SESSION, continuedInSessionId: PARKED },
        { type: "continued-in", sessionId: SESSION, continuedInSessionId: PARKED },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      writeFileSync(join(folder, `${BG}.jsonl`), JSON.stringify({ type: "user", message: { content: "earlier job" } }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    });

    it("checks the job's state.json when it names a transcript (regression: fails on main; mismatch is a control)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = resumed(folder);
      const job = join(folder, `${BG}.jsonl`);
      writeFileSync(job, "{}");
      const state = join(dir, ".claude", "jobs", "8b80137e");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "state.json"), JSON.stringify({ linkScanPath: join(folder, "other.jsonl") }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
      writeFileSync(join(state, "state.json"), JSON.stringify({ linkScanPath: job }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(job);
    });

    it.skipIf(!NATIVE)("reads the job's state bounded, and no FIFO in its place, without blocking (#1876)", async () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = resumed(folder);
      const job = join(folder, `${BG}.jsonl`);
      writeFileSync(job, "{}");
      const state = join(dir, ".claude", "jobs", "8b80137e");
      mkdirSync(state, { recursive: true });
      // larger than a job's state: not read to agree
      writeFileSync(join(state, "state.json"), JSON.stringify({ linkScanPath: job, output: "x".repeat(256 * 1024) }));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
      rmSync(join(state, "state.json"));
      expect(Bun.spawnSync(["mkfifo", join(state, "state.json")]).exitCode).toBe(0);
      const started = Date.now();
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  describe("a /branch (#2020)", () => {
    const BRANCH = "09512ed9-5df9-4105-954e-6597a3119b75";
    const DEEPER = "55555555-5555-4555-8555-555555555555";
    const OTHER = "66666666-6666-4666-8666-666666666666";
    /** What Claude Code 2.1.311 writes for /branch: the conversation so far, each record carrying the session it came from, then the new turns. */
    const branched = (folder: string, id: string, from: string | null, prompt = "Reply with exactly the word ALPHA"): string => {
      const path = join(folder, `${id}.jsonl`);
      const forkedFrom = from === null ? {} : { forkedFrom: { sessionId: from, messageUuid: "e92def5e-231f-4b62-9766-8c9c44012d9b" } };
      writeFileSync(path, [
        { parentUuid: null, type: "user", message: { role: "user", content: prompt }, uuid: "e92def5e-231f-4b62-9766-8c9c44012d9b", sessionId: id, ...forkedFrom },
        { type: "assistant", message: { content: [{ type: "text", text: "ALPHA" }] }, sessionId: id, ...forkedFrom },
        { type: "system", subtype: "local_command", content: "<local-command-stdout>Branched conversation.</local-command-stdout>", sessionId: id },
        { type: "user", message: { content: "Reply with exactly the word BRAVO" }, sessionId: id },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      return path;
    };
    const setup = () => {
      const { home: dir, projects } = home();
      const folder = join(projects, claudeProjectDir("/w/project"));
      mkdirSync(folder, { recursive: true });
      const original = branched(folder, SESSION, null);
      return { dir, projects, folder, original };
    };

    it("takes the branch the process's PID record names over the session it was copied from (regression: fails on main)", async () => {
      const { dir, folder } = setup();
      const branch = branched(folder, BRANCH, SESSION);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], join(dir, ".claude"), BRANCH)).toBe(branch);
      // a branch of that branch, as a second /branch writes it
      const deeper = branched(folder, DEEPER, BRANCH);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], join(dir, ".claude"), DEEPER)).toBe(deeper);
    });

    it("keeps the reported session when the live one is no branch of it (control)", async () => {
      const { dir, projects, folder, original } = setup();
      const store = join(dir, ".claude");
      // the same session, as after /resume back to it; or none known
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, SESSION)).toBe(original);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, null)).toBe(original);
      // a session that was never branched, one branched from another session, and a branch in another project
      branched(folder, OTHER, null);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, OTHER)).toBe(original);
      branched(folder, BRANCH, OTHER);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(original);
      mkdirSync(join(projects, "-elsewhere"));
      branched(join(projects, "-elsewhere"), DEEPER, SESSION);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, DEEPER)).toBe(original);
      // a live session with no transcript yet
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, "77777777-7777-4777-8777-777777777777")).toBe(original);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps the reported transcript when an unreadable project sits beside a live session with no file (regression)", async () => {
      const { dir, projects, original } = setup();
      const locked = join(projects, "-locked");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], join(dir, ".claude"), "77777777-7777-4777-8777-777777777777")).toBe(original);
      } finally { chmodSync(locked, 0o700); }
    });

    it("follows the very branch file it checked, not the same id in a project a cwd names first (#2118)", async () => {
      const { dir, projects, folder } = setup();
      const branch = branched(folder, BRANCH, SESSION);
      mkdirSync(join(projects, claudeProjectDir("/w/first")));
      branched(join(projects, claudeProjectDir("/w/first")), BRANCH, null);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/first", "/w/project"], join(dir, ".claude"), BRANCH)).toBe(branch);
    });

    it("follows a branch's continuation beside it, not the same id in a project a cwd names first (#2130)", async () => {
      const { dir, projects, folder } = setup();
      const CONTINUED = "88888888-8888-4888-8888-888888888888";
      const branch = branched(folder, BRANCH, SESSION);
      appendFileSync(branch, JSON.stringify({ type: "continued-in", sessionId: BRANCH, continuedInSessionId: CONTINUED }) + "\n");
      const beside = branched(folder, CONTINUED, null);
      mkdirSync(join(projects, claudeProjectDir("/w/first")));
      branched(join(projects, claudeProjectDir("/w/first")), CONTINUED, null);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/first", "/w/project"], join(dir, ".claude"), BRANCH)).toBe(beside);
      // control: a reported transcript that is no checked branch keeps looking its continuation up by cwd first
      expect(await claudeTranscriptFile(dir, BRANCH, ["/w/first", "/w/project"], join(dir, ".claude")))
        .toBe(join(projects, claudeProjectDir("/w/first"), `${CONTINUED}.jsonl`));
    });

    it("reads a first record whose keys are escaped as the record it is (#2130)", async () => {
      const { dir, folder, original } = setup();
      const path = join(folder, `${BRANCH}.jsonl`);
      // the first user record names no parent; only a later one claims SESSION
      const first = JSON.stringify({ type: "user", message: { content: "hi" }, sessionId: BRANCH }).replace('"type"', '"\\u0074ype"');
      writeFileSync(path, `${first}\n${JSON.stringify({ type: "user", message: { content: "again" }, sessionId: BRANCH, forkedFrom: { sessionId: SESSION } })}\n`);
      expect(JSON.parse(first).type).toBe("user"); // control: the record is a user record
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], join(dir, ".claude"), BRANCH)).toBe(original);
    });

    it("takes the branch's parent only from its own first conversation record (#2118)", async () => {
      const { dir, folder, original } = setup();
      const store = join(dir, ".claude");
      const path = join(folder, `${BRANCH}.jsonl`);
      const write = (...entries: Record<string, unknown>[]) => writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      // metadata before the conversation names the parent; the conversation does not
      write({ type: "file-history-snapshot", forkedFrom: { sessionId: SESSION } }, { type: "user", message: { content: "hi" }, sessionId: BRANCH });
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(original);
      // a first record of another session's
      forgetClaudeSessions();
      write({ type: "user", message: { content: "hi" }, sessionId: OTHER, forkedFrom: { sessionId: SESSION } });
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(original);
    });

    it("reads a branch's head again once it was written afresh in the same file (#2118)", async () => {
      const { dir, folder, original } = setup();
      const store = join(dir, ".claude");
      const branch = branched(folder, BRANCH, OTHER);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(original);
      // the same inode, written again from the start
      branched(folder, BRANCH, SESSION, "Reply with exactly the word ALPHA, again");
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(branch);
    });

    it("follows no branch whose first record is not all written, or not within the bytes it reads (control)", async () => {
      const { dir, folder, original } = setup();
      const store = join(dir, ".claude");
      const branch = join(folder, `${BRANCH}.jsonl`);
      const record = JSON.stringify({ type: "user", message: { content: "Prompt" }, sessionId: BRANCH, forkedFrom: { sessionId: SESSION } });
      writeFileSync(branch, record);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(original);
      // a first prompt larger than the read: its forkedFrom comes after the message
      branched(folder, BRANCH, SESSION, "x".repeat(1024 * 1024 + 1));
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(original);
      // once the line is whole, it is followed
      writeFileSync(branch, `${record}\n`);
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"], store, BRANCH)).toBe(branch);
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("returns an unreadable transcript for its reader to report", async () => {
    const { home: dir, projects } = home();
    const folder = join(projects, claudeProjectDir("/w/project"));
    mkdirSync(folder, { recursive: true });
    const original = join(folder, `${SESSION}.jsonl`);
    writeFileSync(original, JSON.stringify({ type: "user", message: { content: "hi" } }));
    chmodSync(original, 0o000);
    try {
      expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBe(original);
    } finally {
      chmodSync(original, 0o600);
    }
  });
});

describe("CLAUDE_CONFIG_DIR", () => {
  afterEach(() => forgetClaudeSessions());
  it("reads the last assignment of a ps line, through a path with spaces", () => {
    expect(configDirInPsLine("claude --resume HOME=/h CLAUDE_CONFIG_DIR=/Users/me/.cac/envs/work/.claude PATH=/bin")).toBe("/Users/me/.cac/envs/work/.claude");
    expect(configDirInPsLine("claude CLAUDE_CONFIG_DIR=/a b/.claude")).toBe("/a b/.claude");
    expect(configDirInPsLine("claude HOME=/h")).toBeNull();
  });

  it("finds a transcript in the given store instead of ~/.claude", async () => {
    forgetClaudeSessions();
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-dir-"));
    try {
      const store = join(home, "env", ".claude");
      mkdirSync(join(store, "projects", claudeProjectDir("/work/app")), { recursive: true });
      const path = join(store, "projects", claudeProjectDir("/work/app"), `${SESSION}.jsonl`);
      writeFileSync(path, "{}\n");
      expect(await claudeTranscriptFile(home, SESSION, ["/work/app"])).toBeNull();
      expect(await claudeTranscriptFile(home, SESSION, ["/work/app"], store)).toBe(path);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("reads a running process's own store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-claude-env-"));
    // macOS hides system binaries' environments; use a started user process, as Claude is.
    const sleeper = (env: Record<string, string | undefined>) => Bun.spawn(
      [process.execPath, "-e", "console.log('ready'); await Bun.sleep(5000)"], { env, stdout: "pipe" },
    );
    const child = sleeper({ ...process.env, CLAUDE_CONFIG_DIR: dir });
    const bare = sleeper({ PATH: process.env["PATH"] ?? "" });
    try {
      for (const process of [child, bare]) await process.stdout.getReader().read();
      expect(await processClaudeConfigDir(child.pid)).toBe(dir);
      expect(await processClaudeConfigDir(bare.pid)).toBeNull();
    } finally { child.kill(); bare.kill(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("a Claude process's store source", () => {
  // a started user process stands for Claude: macOS hides system binaries' environments
  const children: { kill: () => void; exited: Promise<number> }[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    forgetClaudeSessions();
    for (const child of children.splice(0)) { child.kill(); await child.exited; }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  // alive until the test ends it: it waits on a stdin nothing writes to, and says it is ready first
  const KEEP_ALIVE = "process.stdin.resume(); console.log('ready')";
  const standIn = async (env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, "-e", KEEP_ALIVE], { env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env }, stdin: "pipe", stdout: "pipe" });
    children.push(child);
    await child.stdout.getReader().read();
    return child.pid;
  };
  const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-claude-source-")); roots.push(dir); return dir; };

  it.skipIf(!NATIVE)("reads an exported store, an empty export and none exported as three sources", async () => {
    const store = tempDir();
    expect(await processClaudeSource(await standIn({ CLAUDE_CONFIG_DIR: store }))).toEqual({ state: "override", dir: store });
    expect(await processClaudeSource(await standIn({ CLAUDE_CONFIG_DIR: "" }))).toEqual({ state: "override", dir: "" });
    expect(await processClaudeSource(await standIn({}))).toEqual({ state: "absent" });
    // the same text inside another variable's value is that variable's, not an export
    expect(await processClaudeSource(await standIn({ NOTE: `example CLAUDE_CONFIG_DIR=${store}` }))).toEqual({ state: "absent" });
  });

  it("reads the environment in a KERN_PROCARGS2 answer whole", () => {
    // argc, the executable's path and its padding, the arguments, then the environment, each NUL-terminated
    const answer = (argc: number, words: string[]) => {
      const count = Buffer.alloc(4);
      count.writeInt32LE(argc);
      return new Uint8Array(Buffer.concat([count, Buffer.from("/usr/local/bin/claude\0\0\0\0"), ...words.map((word) => Buffer.from(`${word}\0`))]));
    };
    const lookalike = "NOTE=example CLAUDE_CONFIG_DIR=/Users/u/.claude-work";
    expect(procArgsEnvironment(answer(2, ["claude", "--resume", "PATH=/usr/bin", lookalike, "", "junk"]))).toEqual(["PATH=/usr/bin", lookalike]);
    // an argument naming the variable stays an argument
    expect(procArgsEnvironment(answer(2, ["claude", "CLAUDE_CONFIG_DIR=/x", "HOME=/Users/u"]))).toEqual(["HOME=/Users/u"]);
    // cut short: fewer arguments than argc, or an entry with no end
    expect(procArgsEnvironment(answer(3, ["claude"]))).toBeNull();
    expect(procArgsEnvironment(new Uint8Array([1, 0, 0, 0, 0x2f, 0x62, 0]).subarray(0, 6))).toBeNull();
  });

  it("macOS reads the environment as the kernel keeps it: another value's text is no export", async () => {
    const store = tempDir();
    const home = tempDir();
    const environments: (string | null)[] = [];
    const environment = spyOn(darwinProcess, "environment").mockImplementation(() => environments.shift() ?? null);
    // the live chat's reading stays ps's: it answers nothing here
    const spawned = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill: () => {} })) as unknown as typeof Bun.spawn);
    try {
      const read = async (environ: string | null) => { forgetClaudeSessions(); environments.push(environ); return processClaudeSource(4242, ["claude"], home, "darwin"); };
      expect(await read(`PATH=/usr/bin\0CLAUDE_CONFIG_DIR=${store}\0HOME=${home}`)).toEqual({ state: "override", dir: store });
      expect(await read(`PATH=/usr/bin\0CLAUDE_CONFIG_DIR=\0HOME=${home}`)).toEqual({ state: "override", dir: "" });
      // NOTE="example CLAUDE_CONFIG_DIR=<store>", which `ps -E` prints as if it were an export: nothing exported
      expect(await read(`PATH=/usr/bin\0NOTE=example CLAUDE_CONFIG_DIR=${store}\0HOME=${home}`)).toEqual({ state: "absent" });
      // another user's process, or one gone: no proof
      expect(await read(null)).toEqual({ state: "unreadable" });
    } finally { environment.mockRestore(); spawned.mockRestore(); }
  });

  it.skipIf(process.platform !== "linux")("herdr's launch source is the environment of the server on its socket", async () => {
    const root = tempDir();
    const store = tempDir();
    // a stand-in herdr server: listens on its socket, then says it is ready, alive until the test ends it
    const server = async (socket: string, env: Record<string, string>) => {
      const child = Bun.spawn([process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(socket)}, socket: { data() {} } }); ${KEEP_ALIVE}`], { env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env }, stdin: "pipe", stdout: "pipe" });
      children.push(child);
      await child.stdout.getReader().read();
    };
    await server(join(root, "exported.sock"), { CLAUDE_CONFIG_DIR: store });
    await server(join(root, "none.sock"), {});
    // the pane's shell may have dropped the variable: herdr's own environment is what a new tab gets
    expect(await herdrLaunchSource(join(root, "exported.sock"))).toEqual({ state: "override", dir: store });
    expect(await herdrLaunchSource(join(root, "none.sock"))).toEqual({ state: "absent" });
    // no server on the socket: no proof
    expect(await herdrLaunchSource(join(root, "nobody.sock"))).toEqual({ state: "unreadable" });
  });

  it("herdr-core's launch source is its core process's environment, not this server's", async () => {
    // a stand-in /proc: the core's environment exports a store, this server's does not
    const proc = tempDir();
    const store = tempDir();
    mkdirSync(join(proc, "41"));
    writeFileSync(join(proc, "41", "environ"), `PATH=/usr/bin\0CLAUDE_CONFIG_DIR=${store}\0`);
    mkdirSync(join(proc, "42"));
    writeFileSync(join(proc, "42", "environ"), "PATH=/usr/bin\0");
    expect(await processLaunchSource(41, "linux", proc, {})).toEqual({ state: "override", dir: store });
    expect(await processLaunchSource(42, "linux", proc, { CLAUDE_CONFIG_DIR: store })).toEqual({ state: "absent" });
    // the core gone: no proof
    expect(await processLaunchSource(43, "linux", proc, {})).toEqual({ state: "unreadable" });
    // macOS reads the core's own environment too, not this server's
    const environment = spyOn(darwinProcess, "environment").mockImplementation((pid: number) => pid === 41 ? `CLAUDE_CONFIG_DIR=${store}\0` : null);
    try {
      expect(await processLaunchSource(41, "darwin", proc, {})).toEqual({ state: "override", dir: store });
      expect(await processLaunchSource(43, "darwin", proc, { CLAUDE_CONFIG_DIR: store })).toEqual({ state: "unreadable" });
    } finally { environment.mockRestore(); }
  });

  it("macOS and Windows take the bridge server's own environment for the one a new tab inherits", async () => {
    // herdr's environment cannot be found there: none exported to the bridge is none for the new tab
    const store = tempDir();
    for (const platform of ["darwin", "win32"]) {
      expect(await herdrLaunchSource("/nowhere.sock", platform, "/proc", {})).toEqual({ state: "absent" });
      expect(await herdrLaunchSource("/nowhere.sock", platform, "/proc", { CLAUDE_CONFIG_DIR: store })).toEqual({ state: "override", dir: store });
      expect(await herdrLaunchSource("/nowhere.sock", platform, "/proc", { CLAUDE_CONFIG_DIR: join(store, "missing") })).toEqual({ state: "unreadable" });
    }
  });

  it.skipIf(process.platform === "win32")("reads herdr's environment once per listening socket", async () => {
    // a /proc of its own: herdr (pid 77) holds the listening socket's inode
    const proc = tempDir();
    const socket = "/run/herdr.sock";
    const table = (inode: number) => `Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 ${inode} ${socket}\n`;
    mkdirSync(join(proc, "net"));
    writeFileSync(join(proc, "net", "unix"), table(4100));
    mkdirSync(join(proc, "77", "fd"), { recursive: true });
    symlinkSync("socket:[4100]", join(proc, "77", "fd", "3"));
    writeFileSync(join(proc, "77", "environ"), "HOME=/home/u\0PATH=/usr/bin\0");
    expect(await herdrLaunchSource(socket, "linux", proc)).toEqual({ state: "absent" });
    // the same socket: the answer is kept, with no walk of the processes (herdr's own is gone from this /proc)
    rmSync(join(proc, "77"), { recursive: true });
    expect(await herdrLaunchSource(socket, "linux", proc)).toEqual({ state: "absent" });
    // a restarted herdr listens on a new socket: read again
    writeFileSync(join(proc, "net", "unix"), table(4200));
    expect(await herdrLaunchSource(socket, "linux", proc)).toEqual({ state: "unreadable" });
  });

  it.skipIf(!NATIVE)("unreadable Claude environment is not a proven absent override", async () => {
    // a process that is gone (its environment cannot be read) and a named store that is not a directory
    const gone = Bun.spawn([process.execPath, "-e", "0"]);
    await gone.exited;
    expect(await processClaudeSource(gone.pid, ["gone"])).toEqual({ state: "unreadable" });
    expect(await processClaudeSource(await standIn({ CLAUDE_CONFIG_DIR: join(tempDir(), "missing") }))).toEqual({ state: "unreadable" });
    expect(await processClaudeSource(await standIn({ CLAUDE_CONFIG_DIR: "relative/store" }))).toEqual({ state: "unreadable" });
    // neither lists the default store in its place, and the live chat still reads both as no override
    expect(await claudeStoreOf({ state: "unreadable" }, tempDir(), {})).toBeNull();
    expect(await processClaudeConfigDir(gone.pid, ["gone"])).toBeNull();
  });

  it("reads a pane with no Claude as the server's default store, and two Claudes as no answer", async () => {
    const shell = { pid: 1, name: "bash", argv: ["bash"] };
    expect(await paneClaudeSource([shell])).toBeNull();
    expect(await paneClaudeSource([{ pid: 2, name: "claude" }, { pid: 3, name: "claude" }])).toEqual({ state: "ambiguous" });
    const home = tempDir();
    expect((await claudeStoreOf(null, home, {}))?.env).toBeNull();
    expect((await claudeStoreOf(null, home, { CLAUDE_CONFIG_DIR: join(home, "server-store") }))?.env).toEqual({ CLAUDE_CONFIG_DIR: join(home, "server-store") });
  });

  it("finds the server's default store under USERPROFILE when HOME is unset, as native Windows starts it", async () => {
    const profile = tempDir();
    const before = { home: process.env["HOME"], profile: process.env["USERPROFILE"] };
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    delete process.env["HOME"];
    process.env["USERPROFILE"] = profile;
    try {
      // elsewhere USERPROFILE means nothing: the store stays where it was without HOME
      Object.defineProperty(process, "platform", { value: "linux" });
      expect((await claudeStoreOf(null, undefined, {}))?.dir).toBe(".claude");
      Object.defineProperty(process, "platform", { value: "win32" });
      expect((await claudeStoreOf(null, undefined, {}))?.dir).toBe(join(profile, ".claude"));
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (before.home === undefined) delete process.env["HOME"]; else process.env["HOME"] = before.home;
      if (before.profile === undefined) delete process.env["USERPROFILE"]; else process.env["USERPROFILE"] = before.profile;
    }
  });

  it("implicit and explicit default store routes remain distinct", async () => {
    const home = tempDir();
    mkdirSync(join(home, ".claude"));
    const implicit = await claudeStoreOf({ state: "absent" }, home, {});
    const explicit = await claudeStoreOf({ state: "override", dir: join(home, ".claude") }, home, {});
    const empty = await claudeStoreOf({ state: "override", dir: "" }, home, {});
    // one directory, three ways of choosing it: each lists ~/.claude, each resumes as it was chosen
    expect([implicit?.dir, explicit?.dir, empty?.dir]).toEqual([join(home, ".claude"), join(home, ".claude"), join(home, ".claude")]);
    expect([implicit?.env, explicit?.env, empty?.env]).toEqual([null, { CLAUDE_CONFIG_DIR: join(home, ".claude") }, { CLAUDE_CONFIG_DIR: "" }]);
    expect(new Set([implicit?.key, explicit?.key, empty?.key]).size).toBe(3);
    // one folder all the same: one place, where both would write one transcript
    expect(new Set([implicit?.place, explicit?.place, empty?.place]).size).toBe(1);
    expect(implicit?.place).not.toBe(implicit?.key);
    for (const key of [implicit?.key, explicit?.key, empty?.key]) expect(key).toMatch(/^[0-9a-f]{24}$/);
    // the key names the store, not the path: another spelling of the same directory is the same key
    symlinkSync(join(home, ".claude"), join(home, "link"));
    expect((await claudeStoreOf({ state: "override", dir: join(home, "link") }, home, {}))?.key).toBe(explicit?.key);
    expect(explicit?.key).not.toContain(home);
  });
});

describe("a Windows Claude's store", () => {
  // Windows lets no one read another process's environment: the store is the one holding the
  // live PID record. These run anywhere, with the process table handed in (windows-native.test.ts
  // checks the real one).
  const PID = 4242;
  const STARTED = 1_791_384_794_216;
  // what Claude writes: FILETIME, 100 ns since 1601, with the part of a millisecond the table drops
  const PROC_START = String((BigInt(STARTED) + 11_644_473_600_000n) * 10_000n + 8714n);
  const CLAUDE_EXE = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const table = async (): Promise<ProcessRow[]> => [{ pid: PID, parent: 1, path: CLAUDE_EXE, commandLine: `"${CLAUDE_EXE}"`, started: STARTED }];
  const roots: string[] = [];
  let serverConfigDir: string | undefined;
  beforeEach(() => { serverConfigDir = process.env["CLAUDE_CONFIG_DIR"]; delete process.env["CLAUDE_CONFIG_DIR"]; });
  afterEach(() => {
    forgetClaudeSessions();
    if (serverConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = serverConfigDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function home(): string {
    const root = mkdtempSync(join(tmpdir(), "herdr-claude-win-"));
    roots.push(root);
    const home = join(root, "User With Spaces");
    mkdirSync(home);
    return home;
  }
  function record(store: string, patch: Record<string, unknown> = {}): void {
    mkdirSync(join(store, "sessions"), { recursive: true });
    writeFileSync(join(store, "sessions", `${PID}.json`), JSON.stringify({
      pid: PID, sessionId: SESSION, procStart: PROC_START, kind: "interactive", ...patch,
    }));
  }
  function transcript(store: string, cwd: string): string {
    const folder = join(store, "projects", claudeProjectDir(cwd));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${SESSION}.jsonl`), "{}\n");
    return join(folder, `${SESSION}.jsonl`);
  }
  const storeOf = (dir: string, rows = table) => processClaudeConfigDir(PID, [CLAUDE_EXE], dir, "win32", rows);

  it("knows Claude in herdr's Windows process info, and only Claude", () => {
    expect(isClaudeProcess({ name: "claude.exe", argv0: CLAUDE_EXE, argv: [CLAUDE_EXE] })).toBe(true);
    expect(isClaudeProcess({ name: "claude" })).toBe(true);
    expect(isClaudeProcess({ name: "node", argv0: "claude" })).toBe(true);
    expect(isClaudeProcess({ name: "node", argv: ["/usr/local/bin/claude", "--resume"] })).toBe(true);
    expect(isClaudeProcess({ name: "claude-helper.exe", argv0: "C:\\tools\\claude-helper.exe" })).toBe(false);
    expect(isClaudeProcess({ name: "notclaude.exe", argv: ["C:\\tools\\notclaude.exe"] })).toBe(false);
    expect(isClaudeProcess({ name: "node", argv: ["/usr/bin/node", "claude"] })).toBe(false);
    // Windows names files without case; POSIX keeps it
    expect(isClaudeProcess({ name: "Claude.EXE", argv0: "C:\\Tools\\Claude.EXE" })).toBe(true);
    expect(isClaudeProcess({ name: "node", argv: ["C:\\Tools\\CLAUDE"] })).toBe(true);
    expect(isClaudeProcess({ name: "Claude", argv: ["/usr/local/bin/Claude"] })).toBe(false);
  });

  it("finds a store whose name differs from ~/.claude-* only in case", async () => {
    const dir = home();
    record(join(dir, ".Claude-Work"));
    expect(await storeOf(dir)).toBe(join(dir, ".Claude-Work"));
  });

  it("keeps the default store for a Claude that writes there", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    mkdirSync(join(dir, ".claude-second", "sessions"), { recursive: true });
    expect(await storeOf(dir)).toBe(join(dir, ".claude"));
    expect(await claudeProcessSession(dir, PID, join(dir, ".claude"), "win32", table)).toBe(SESSION);
  });

  it("finds a ~/.claude-* store by its live PID record, and the transcript in it before ~/.claude's", async () => {
    const dir = home();
    const second = join(dir, ".claude-second");
    const cwd = "D:\\work\\my app";
    // the same session id under the same project in both stores: only the PID record tells them apart
    transcript(join(dir, ".claude"), cwd);
    const own = transcript(second, cwd);
    record(second);
    const store = await storeOf(dir);
    expect(store).toBe(second);
    expect(await claudeProcessSession(dir, PID, store!, "win32", table)).toBe(SESSION);
    expect(await claudeTranscriptFile(dir, SESSION, [cwd], store!)).toBe(own);
  });

  it("prefers the live record over a stale one of the same PID in another store", async () => {
    const dir = home();
    record(join(dir, ".claude"), { procStart: String(BigInt(PROC_START) - 10_000_000n) });
    record(join(dir, ".claude-work"));
    expect(await storeOf(dir)).toBe(join(dir, ".claude-work"));
  });

  for (const [name, patch] of [
    ["another PID", { pid: PID + 4 }],
    ["a reused PID", { procStart: String(BigInt(PROC_START) + 10_000n) }],
    ["a start in another platform's form", { procStart: "Wed Oct  7 14:53:14 2026" }],
    ["an older record without a start", { procStart: null }],
    ["a noninteractive SDK session", { kind: "sdk" }],
    ["a path in place of a UUID", { sessionId: "..\\..\\other" }],
  ] satisfies [string, Record<string, unknown>][]) {
    it(`ignores a record with ${name}`, async () => {
      const dir = home();
      record(join(dir, ".claude-second"), patch);
      expect(await storeOf(dir)).toBeNull();
      expect(await claudeProcessSession(dir, PID, join(dir, ".claude-second"), "win32", table)).toBeNull();
    });
  }

  it("ignores a torn or oversized record, and a process the table cannot show", async () => {
    const dir = home();
    const path = join(dir, ".claude-second", "sessions", `${PID}.json`);
    record(join(dir, ".claude-second"));
    writeFileSync(path, "{");
    expect(await storeOf(dir)).toBeNull();
    writeFileSync(path, JSON.stringify({ padding: "x".repeat(16 * 1024) }));
    expect(await storeOf(dir)).toBeNull();
    record(join(dir, ".claude-second"));
    expect(await storeOf(dir, async () => [])).toBeNull();
  });

  it("is not misled by ~/.claude-* names that hold no store", async () => {
    const dir = home();
    writeFileSync(join(dir, ".claude-notes"), "a file, not a store");
    mkdirSync(join(dir, ".claude-empty"));
    mkdirSync(join(dir, ".claude-old", "sessions"), { recursive: true });
    expect(await storeOf(dir)).toBeNull();
    expect(await processClaudeConfigDir(PID, [CLAUDE_EXE], join(dir, "missing"), "win32", table)).toBeNull();
    record(join(dir, ".claude-second"));
    expect(await storeOf(dir)).toBe(join(dir, ".claude-second"));
  });

  it("refuses to pick a store when two stores both claim the process, rather than fall back to ~/.claude (#586)", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    record(join(dir, ".claude-copy"));
    await expect(storeOf(dir)).rejects.toBeInstanceOf(AmbiguousClaudeStore);
    // and asks again: the copy may be removed
    rmSync(join(dir, ".claude-copy"), { recursive: true });
    expect(await storeOf(dir)).toBe(join(dir, ".claude"));
  });

  it("counts one store reached by two names once, rather than as two that claim the process (#586)", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    // CLAUDE_CONFIG_DIR naming ~/.claude another way (on Windows its \\?\ spelling, or a junction to it)
    symlinkSync(join(dir, ".claude"), join(dir, "claude-link"));
    const before = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = join(dir, "claude-link");
    try {
      expect(await storeOf(dir)).toBe(join(dir, "claude-link"));
    } finally {
      if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"]; else process.env["CLAUDE_CONFIG_DIR"] = before;
    }
  });

  it("knows a store without a file id by its spelling without the \\\\?\\ prefix or the drive letter's case (#586)", () => {
    const store = "C:\\Users\\u\\.claude";
    for (const id of [null, { dev: 7n, ino: 0n }]) {
      expect(claudeStoreKey(`\\\\?\\${store}`, id, win32)).toBe(claudeStoreKey(store, id, win32));
      expect(claudeStoreKey("\\\\?\\c:\\Users\\u\\.claude", id, win32)).toBe(claudeStoreKey(store, id, win32));
      // past the drive letter a case-sensitive directory may be another store: both are asked
      expect(claudeStoreKey("C:\\Users\\u\\.Claude", id, win32)).not.toBe(claudeStoreKey(store, id, win32));
      expect(claudeStoreKey("C:\\Users\\u\\.claude-Work", id, win32)).not.toBe(claudeStoreKey("C:\\Users\\u\\.claude-work", id, win32));
      expect(claudeStoreKey("\\\\?\\UNC\\host\\share\\.claude", id, win32)).toBe(claudeStoreKey("\\\\host\\share\\.claude", id, win32));
      expect(claudeStoreKey(`${store}-work`, id, win32)).not.toBe(claudeStoreKey(store, id, win32));
    }
    expect(claudeStoreKey("C:\\a", { dev: 7n, ino: 42n }, win32)).toBe(claudeStoreKey("\\\\?\\D:\\b", { dev: 7n, ino: 42n }, win32));
  });

  it("tells a ~/.claude found by its PID record from an override, and resumes it with none exported", async () => {
    const dir = home();
    record(join(dir, ".claude"));
    expect(await processClaudeSource(PID, [CLAUDE_EXE], dir, "win32", table)).toEqual({ state: "store", dir: join(dir, ".claude") });
    // how it was chosen cannot be told: none exported reaches ~/.claude again, the default setup's Resume
    const store = await claudeStoreOf({ state: "store", dir: join(dir, ".claude") }, dir, {});
    expect(store?.env).toBeNull();
    expect(store?.dir).toBe(join(dir, ".claude"));
    forgetClaudeSessions();
    rmSync(join(dir, ".claude"), { recursive: true });
    record(join(dir, ".claude-second"));
    expect(await processClaudeSource(PID, [CLAUDE_EXE], dir, "win32", table)).toEqual({ state: "override", dir: join(dir, ".claude-second") });
    record(join(dir, ".claude-copy"));
    forgetClaudeSessions();
    expect(await processClaudeSource(PID, [CLAUDE_EXE], dir, "win32", table)).toEqual({ state: "ambiguous" });
    expect(await claudeStoreOf({ state: "ambiguous" }, dir, {})).toBeNull();
  });

  it("takes a store only as the one holder of the live record: a copy made while Claude ran proves neither", async () => {
    const dir = home();
    const work = join(dir, ".claude-work");
    record(work);
    expect(await claudeRecordOnlyIn(dir, PID, work, "win32", table)).toBe(true);
    // cp -r ~/.claude-work ~/.claude while it ran: the same live record in both
    record(join(dir, ".claude"));
    expect(await claudeRecordOnlyIn(dir, PID, work, "win32", table)).toBe(false);
    expect(await claudeRecordOnlyIn(dir, PID, join(dir, ".claude"), "win32", table)).toBe(false);
    expect(await processClaudeSource(PID, [CLAUDE_EXE], dir, "win32", table)).toEqual({ state: "ambiguous" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("takes a record that is there but cannot be read for one that may be live, not for none", async () => {
    const dir = home();
    const work = join(dir, ".claude-work");
    record(work);
    record(join(dir, ".claude"));
    const original = join(dir, ".claude", "sessions", `${PID}.json`);
    chmodSync(original, 0o000);
    try {
      expect(await claudeRecordOnlyIn(dir, PID, work, "win32", table)).toBe(false);
      expect(await processClaudeSource(PID, [CLAUDE_EXE], dir, "win32", table)).toEqual({ state: "ambiguous" });
    } finally { chmodSync(original, 0o600); }
  });

  it.skipIf(process.platform === "win32")("takes a record that passes lstat and access but fails to read for one that may be live", async () => {
    // a link in the record's place: lstat and access see it, the read refuses it (no links followed)
    const dir = home();
    const work = join(dir, ".claude-work");
    record(work);
    record(join(dir, "elsewhere"));
    mkdirSync(join(dir, ".claude", "sessions"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "sessions", `${PID}.json`), join(dir, ".claude", "sessions", `${PID}.json`));
    expect(await claudeRecordOnlyIn(dir, PID, work, "win32", table)).toBe(false);
    expect(await processClaudeSource(PID, [CLAUDE_EXE], dir, "win32", table)).toEqual({ state: "ambiguous" });
    // the live chat's reading is unchanged: a record it cannot read names no session
    expect(await claudeProcessSession(dir, PID, join(dir, ".claude"), "win32", table)).toBeNull();
  });

  it("looks again after a miss, since Claude writes its record as it starts", async () => {
    const dir = home();
    expect(await storeOf(dir)).toBeNull();
    record(join(dir, ".claude-second"));
    expect(await storeOf(dir)).toBe(join(dir, ".claude-second"));
  });
});

describe("claudeSessionTempDir", () => {
  const session = "6b93e6b7-7279-449a-b4ab-66e91f7a21d9";
  const transcript = `/home/u/.claude/projects/-home-u-project/${session}.jsonl`;
  const uid = process.getuid?.();
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-temp-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.skipIf(uid === undefined)("finds the session's folder under the transcript's project", async () => {
    const dir = join(root, `claude-${uid}`, "-home-u-project", session);
    mkdirSync(join(dir, "scratchpad"), { recursive: true });
    expect(await claudeSessionTempDir(transcript, [join(root, "missing"), root], uid)).toBe(dir);
  });

  it.skipIf(uid === undefined)("is null without the folder, for another user's base, or for a name that is not a session", async () => {
    expect(await claudeSessionTempDir(transcript, [root], uid)).toBeNull();
    mkdirSync(join(root, `claude-${uid! + 1}`, "-home-u-project", session), { recursive: true });
    // the base exists but under another uid's name; and a base this user owns is not that uid's
    expect(await claudeSessionTempDir(transcript, [root], uid! + 1)).toBeNull();
    expect(await claudeSessionTempDir("/home/u/.claude/projects/-home-u-project/notes.jsonl", [root], uid)).toBeNull();
    expect(await claudeSessionTempDir(transcript, [root], undefined)).toBeNull();
  });
});
